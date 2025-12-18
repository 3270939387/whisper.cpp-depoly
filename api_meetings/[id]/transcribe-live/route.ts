import { NextRequest, NextResponse } from 'next/server'
import { createClients } from '@/utils/supabase/server'
import { parseLanguageForWhisper } from '@/utils/transcription-language'
import { convertToSimplified } from '@/utils/chinese-converter'
// 实时转录不使用静音检测（片段太短，RMS计算不准确）
// import { isAudioSilentSimple } from '@/utils/audio-silence-detector'
import OpenAI from 'openai'

// Vercel 函数配置：设置最大执行时间为 5 分钟（300秒）
// 实时转录片段通常较短，但需要足够的处理时间
export const maxDuration = 300 // 5分钟 = 300秒
export const dynamic = 'force-dynamic'

// 格式化时间戳
function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`
}

// POST /api/meetings/[id]/transcribe-live - 实时转录音频片段
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const formData = await request.formData()
    const audioFile = formData.get('audio') as File
    const startTimeStr = formData.get('startTime') as string // 音频片段的起始时间（秒）
    const windowStartTimeStr = formData.get('windowStartTime') as string // 窗口开始时间（用于重叠识别）
    const lastProcessedTimeStr = formData.get('lastProcessedTime') as string // 上次处理的时间点（用于增量识别）
    const language = formData.get('language') as string || 'auto' // 语言参数
    
    if (!audioFile) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 })
    }

    if (!startTimeStr) {
      return NextResponse.json({ error: 'No startTime provided' }, { status: 400 })
    }

    const startTime = parseFloat(startTimeStr)
    const windowStartTime = windowStartTimeStr ? parseFloat(windowStartTimeStr) : startTime
    const lastProcessedTime = lastProcessedTimeStr ? parseFloat(lastProcessedTimeStr) : 0

    // 检查 API 密钥
    if (!process.env.WHISPER_API_KEY) {
      return NextResponse.json(
        { error: 'WHISPER_API_KEY not configured' },
        { status: 500 }
      )
    }

    console.log('🔊 使用 LemonFox.ai Whisper API 进行实时转录:', {
      audioFileSize: audioFile.size,
      audioFileType: audioFile.type,
      language: language,
      startTime: startTime
    })

    // 实时转录跳过静音检测：
    // 1. 实时片段较短（6秒），RMS计算可能不够准确，容易误判
    // 2. 即使有静音，Whisper API也会返回空结果，不会造成问题
    // 3. 跳过静音检测可以减少延迟，提高响应速度
    // 4. 最终转录（完整音频）仍会进行静音检测
    // 
    // 如果需要静音检测，可以在最终转录时进行

    let transcriptionResult: { text: string; language?: string; segments?: any[] }

    try {
      // 初始化 OpenAI 客户端，使用 LemonFox.ai 的 baseURL
      const openai = new OpenAI({
        apiKey: process.env.WHISPER_API_KEY,
        baseURL: 'https://api.lemonfox.ai/v1',
      })

      // 准备音频文件
      // 确定文件扩展名
      let fileName = audioFile.name || 'audio.webm'
      if (!fileName.includes('.')) {
        const extension = audioFile.type?.split('/')[1] || 'webm'
        fileName = `audio.${extension}`
      }
      
      // 解析语言参数
      const { language: whisperLang } = parseLanguageForWhisper(language as any)
      
      // 构建转录参数
      const transcriptionParams: any = {
        file: audioFile,
        model: 'whisper-1',
        response_format: 'verbose_json', // 使用 verbose_json 格式以获取带时间戳的 segments
      }

      // 如果 language 不是 'auto' 或 'auto-translate'，则传递 language 参数
      if (whisperLang && whisperLang !== 'auto' && whisperLang !== 'auto-translate') {
        transcriptionParams.language = whisperLang
      }

      // 调用 LemonFox.ai Whisper API
      const result = await openai.audio.transcriptions.create(transcriptionParams)
      
      console.log('✅ LemonFox.ai Whisper API 响应成功:', {
        hasText: !!result.text,
        textLength: result.text?.length || 0,
        hasSegments: !!(result as any).segments,
        segmentsCount: (result as any).segments?.length || 0,
        language: (result as any).language || 'unknown'
      })
      
      // 转换结果格式
      transcriptionResult = {
        text: result.text,
        language: (result as any).language,
        segments: (result as any).segments || []
      }

      if (!transcriptionResult.text || !transcriptionResult.text.trim()) {
        // 如果没有转录文本，返回空结果
        return NextResponse.json({ 
          transcripts: [],
          language: transcriptionResult.language || 'auto'
        })
      }

      // 解析转录结果
      let transcriptText = transcriptionResult.text?.trim() || ''
      const segments = transcriptionResult.segments || [] // Whisper 返回的 segments（包含时间戳）
      
      // 检查转录结果是否包含中文字符，如果是则转换为简体
      // 或者如果用户选择了中文相关的语言选项
      const detectedLanguage = transcriptionResult.language || ''
      const isChinese = language === 'zh' || 
                       language === 'auto' || 
                       language === 'auto-translate' ||
                       detectedLanguage === 'zh' ||
                       detectedLanguage === 'chinese' ||
                       /[\u4e00-\u9fa5]/.test(transcriptText)
      
      if (isChinese && transcriptText && !transcriptText.includes('(speaking in foreign language)')) {
        transcriptText = convertToSimplified(transcriptText)
      }

      // 保存转录到数据库
      const { supabaseServiceRole } = await createClients()
      const transcripts = []

      // 如果有 segments（带时间戳），使用 segments；否则回退到按句子分割
      if (segments && segments.length > 0) {
        // 使用 Whisper 返回的 segments，每个 segment 都有准确的时间戳
        for (const segment of segments) {
          let segmentText = segment.text?.trim() || ''
          
          // 转换为简体中文（如果需要）
          if (isChinese && segmentText && !segmentText.includes('(speaking in foreign language)')) {
            segmentText = convertToSimplified(segmentText)
          }
          
          if (!segmentText) continue
          
          // 使用 segment 的时间戳（相对于窗口开始时间）
          // segment.start 和 segment.end 是相对于音频片段的时间（秒）
          const segmentStartTime = windowStartTime + (segment.start || 0)
          const segmentEndTime = windowStartTime + (segment.end || segment.start || 0)
          const timestamp = formatTimestamp(segmentStartTime)
          
          // 增量识别：只处理上次处理时间之后的新转录
          if (segmentStartTime <= lastProcessedTime) {
            continue
          }
          
          // 检查是否已存在相同时间段的转录（去重）
          const { data: existing } = await supabaseServiceRole
            .from('transcripts')
            .select('id')
            .eq('meeting_id', id)
            .gte('audio_start_time', segmentStartTime - 0.5) // 允许0.5秒的时间容差
            .lte('audio_start_time', segmentStartTime + 0.5)
            .limit(1)
            .single()

          if (existing) {
            // 如果已存在，跳过
            continue
          }

          const { data, error } = await supabaseServiceRole
            .from('transcripts')
            .insert({
              meeting_id: id,
              transcript: segmentText,
              timestamp: timestamp,
              audio_start_time: segmentStartTime,
              audio_end_time: segmentEndTime,
              confidence: 0.95
            })
            .select()
            .single()

          if (!error && data) {
            transcripts.push(data)
          }
        }
      } else {
        // 回退方案：如果没有 segments，按句子分割并估算时间
        const sentences = transcriptText
          .split(/[.!?。！？]\s*/)
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0)

        if (sentences.length === 0) {
          sentences.push(transcriptText)
        }

        // 估算窗口持续时间（约8秒）
        const windowDuration = 8
        const timePerSentence = sentences.length > 0 ? windowDuration / sentences.length : windowDuration

        for (let i = 0; i < sentences.length; i++) {
          const sentenceStartTime = windowStartTime + (i * timePerSentence)
          const sentenceEndTime = windowStartTime + ((i + 1) * timePerSentence)
          const timestamp = formatTimestamp(sentenceStartTime)

          // 增量识别：只处理上次处理时间之后的新转录
          if (sentenceStartTime <= lastProcessedTime) {
            continue
          }

          // 检查是否已存在相同时间段的转录（去重）
          const { data: existing } = await supabaseServiceRole
            .from('transcripts')
            .select('id')
            .eq('meeting_id', id)
            .gte('audio_start_time', sentenceStartTime - 0.5) // 允许0.5秒的时间容差
            .lte('audio_start_time', sentenceStartTime + 0.5)
            .limit(1)
            .single()

          if (existing) {
            // 如果已存在，跳过
            continue
          }

          const { data, error } = await supabaseServiceRole
            .from('transcripts')
            .insert({
              meeting_id: id,
              transcript: sentences[i],
              timestamp: timestamp,
              audio_start_time: sentenceStartTime,
              audio_end_time: sentenceEndTime,
              confidence: 0.95
            })
            .select()
            .single()

          if (!error && data) {
            transcripts.push(data)
          }
        }
      }

      return NextResponse.json({ 
        transcripts,
        language: transcriptionResult.language || 'auto'
      })
    } catch (whisperError: any) {
      console.error('❌ LemonFox.ai Whisper API 错误:', whisperError)
      
      // 如果转录 API 失败，返回空转录而不是错误（实时转录允许失败）
      return NextResponse.json({ 
        transcripts: [],
        language: 'auto'
      })
    }
  } catch (error: any) {
    console.error('Error in POST /api/meetings/[id]/transcribe-live:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
