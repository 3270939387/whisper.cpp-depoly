import { NextRequest, NextResponse } from 'next/server'
import { createClients } from '@/utils/supabase/server'
import { parseLanguageForWhisper } from '@/utils/transcription-language'
import { convertToSimplified } from '@/utils/chinese-converter'
import { isAudioSilentSimple } from '@/utils/audio-silence-detector'
import OpenAI from 'openai'
import { File as UndiciFile } from 'undici'

// Vercel 函数配置：设置最大执行时间为 10 分钟（600秒）
// 这对于处理长音频文件（如10分钟录音）是必需的
export const maxDuration = 600 // 10分钟 = 600秒
export const dynamic = 'force-dynamic'

// 格式化时间戳
function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`
}

// POST /api/meetings/[id]/transcribe - 转录音频文件
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    
    // 检查请求内容类型，支持 FormData 或 JSON
    const contentType = request.headers.get('content-type') || ''
    let audioFile: File | null = null
    let language: string = 'auto'
    let audioDurationStr: string | null = null
    let audioUrl: string | null = null
    
    if (contentType.includes('application/json')) {
      // JSON 格式：支持 audioUrl（用于大文件上传）
      const body = await request.json()
      audioUrl = body.audioUrl || null
      language = body.language || 'auto'
      audioDurationStr = body.audioDuration || null
      
      if (!audioUrl) {
        return NextResponse.json({ error: 'No audioUrl provided' }, { status: 400 })
      }
      
      console.log('📁 接收到音频 URL:', {
        audioUrl,
        language,
        audioDuration: audioDurationStr
      })
      
      // 从 URL 下载音频文件
      try {
        // 检查是否是 base64 data URL（如果没有配置 Blob Storage）
        if (audioUrl.startsWith('data:')) {
          console.warn('⚠️ Received base64 data URL, attempting to convert...')
          // 解析 base64 data URL
          const matches = audioUrl.match(/^data:([^;]+);base64,(.+)$/)
          if (!matches) {
            throw new Error('Invalid base64 data URL format')
          }
          const mimeType = matches[1]
          const base64Data = matches[2]
          const buffer = Buffer.from(base64Data, 'base64')
          // 从 MIME 类型推断文件扩展名
          const extension = mimeType.split('/')[1] || 'wav'
          const fileName = `audio.${extension}`
          // 使用 Buffer 直接创建 UndiciFile（避免 Blob 类型不兼容问题）
          audioFile = new UndiciFile([buffer], fileName, { type: mimeType }) as unknown as File
          console.log('✅ 从 base64 data URL 转换音频文件成功:', {
            name: audioFile.name,
            size: audioFile.size,
            type: audioFile.type
          })
        } else {
          // 普通 URL，使用 fetch 下载
          const response = await fetch(audioUrl)
          if (!response.ok) {
            throw new Error(`Failed to download audio from URL: ${response.statusText}`)
          }
          const arrayBuffer = await response.arrayBuffer()
          // 从 URL 推断文件名和 MIME 类型
          const urlPath = new URL(audioUrl).pathname
          const fileName = urlPath.split('/').pop() || 'audio.wav'
          const contentType = response.headers.get('content-type') || 'audio/wav'
          // 使用 Uint8Array 创建 UndiciFile（避免 Blob 类型不兼容问题）
          audioFile = new UndiciFile([new Uint8Array(arrayBuffer)], fileName, { type: contentType }) as unknown as File
          console.log('✅ 从 URL 下载音频文件成功:', {
            name: audioFile.name,
            size: audioFile.size,
            type: audioFile.type
          })
        }
      } catch (downloadError: any) {
        console.error('❌ 从 URL 下载/转换音频文件失败:', downloadError)
        return NextResponse.json({ 
          error: `Failed to process audio URL: ${downloadError.message}` 
        }, { status: 400 })
      }
    } else {
      // FormData 格式：直接上传的文件
      const formData = await request.formData()
      audioFile = formData.get('audio') as File
      language = formData.get('language') as string || 'auto'
      audioDurationStr = formData.get('audioDuration') as string || null
      
      if (!audioFile) {
        return NextResponse.json({ error: 'No audio file provided' }, { status: 400 })
      }
      
      console.log('📁 接收到的音频文件:', {
        name: audioFile.name,
        size: audioFile.size,
        type: audioFile.type,
        language: language,
        audioDuration: audioDurationStr
      })
    }
    
    // 验证音频文件
    if (!audioFile || audioFile.size === 0) {
      return NextResponse.json({ error: 'Audio file is empty' }, { status: 400 })
    }
    
    // 获取实际录音时长，如果没有提供则估算
    const audioDuration = audioDurationStr ? parseFloat(audioDurationStr) : null

    // 检查 API 密钥
    if (!process.env.WHISPER_API_KEY) {
      return NextResponse.json(
        { error: 'WHISPER_API_KEY not configured' },
        { status: 500 }
      )
    }

    console.log('🔊 使用 LemonFox.ai Whisper API 进行转录:', {
      audioFileSize: audioFile.size,
      audioFileType: audioFile.type,
      language: language
    })

    // 静音检测：在调用 Whisper API 之前先检测音频是否为静音
    // 对于压缩格式（M4A, MP3等），RMS 值通常较低，使用更低的阈值
    try {
      // 根据文件类型选择不同的阈值
      const fileType = audioFile.type?.toLowerCase() || ''
      const fileName = audioFile.name?.toLowerCase() || ''
      const isCompressedFormat = fileType.includes('m4a') || fileType.includes('mp3') || 
                                 fileType.includes('aac') || fileName.endsWith('.m4a') || 
                                 fileName.endsWith('.mp3') || fileName.endsWith('.aac')
      
      // 压缩格式使用更低的阈值（0.01），WAV 等未压缩格式使用稍高的阈值（0.02）
      const threshold = isCompressedFormat ? 0.01 : 0.02
      
      const isSilent = await isAudioSilentSimple(audioFile, threshold)
      
      if (isSilent) {
        console.log('🔇 检测到静音音频，跳过 Whisper API 调用', {
          fileType,
          fileName: audioFile.name,
          threshold,
          isCompressedFormat
        })
        return NextResponse.json({ 
          transcripts: [],
          language: 'auto',
          message: 'no recording detected'
        })
      }
    } catch (silenceDetectionError: any) {
      // 如果静音检测失败，记录错误但继续处理（不阻止转录）
      console.warn('⚠️ 静音检测失败，继续处理音频:', silenceDetectionError.message)
    }

    let transcriptionResult: { text: string; language?: string; segments?: any[] }

    try {
      // 初始化 OpenAI 客户端，使用 LemonFox.ai 的 baseURL
      const openai = new OpenAI({
        apiKey: process.env.WHISPER_API_KEY,
        baseURL: 'https://api.lemonfox.ai/v1',
      })

      // 准备音频文件
      // 确定文件扩展名
      let fileNameForApi = audioFile.name || 'audio.wav'
      if (!fileNameForApi.includes('.')) {
        const extension = audioFile.type?.split('/')[1] || 'wav'
        fileNameForApi = `audio.${extension}`
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
      
      // LemonFox.ai API 返回的格式（与 OpenAI 兼容）：
      // {
      //   text: "...",
      //   language: "zh",
      //   duration: 123.45,
      //   segments: [
      //     { id: 0, start: 0.0, end: 5.0, text: "...", ... }
      //   ]
      // }
      transcriptionResult = {
        text: result.text,
        language: (result as any).language,
        segments: (result as any).segments || []
      }

      if (!transcriptionResult.text || transcriptionResult.text.trim().length === 0) {
        console.error('Transcription result has no text:', {
          hasText: !!transcriptionResult.text,
          textLength: transcriptionResult.text?.length || 0,
          segments: transcriptionResult.segments?.length || 0,
          result: transcriptionResult
        })
        throw new Error('No transcription text received from Whisper service')
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
          
          // 使用 segment 的时间戳（相对于整个音频的开始时间，即 0）
          const segmentStartTime = segment.start || 0
          const segmentEndTime = segment.end || segment.start || 0
          const timestamp = formatTimestamp(segmentStartTime)

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

        // 计算时间戳
        // 如果有实际录音时长，使用实际时长；否则估算
        const totalDuration = audioDuration || (sentences.length * 4) // 如果没有提供，估算每句4秒
        const timePerSentence = totalDuration / Math.max(1, sentences.length)

        for (let i = 0; i < sentences.length; i++) {
          const startTime = i * timePerSentence
          const endTime = (i + 1) * timePerSentence
          const timestamp = formatTimestamp(startTime)

          const { data, error } = await supabaseServiceRole
            .from('transcripts')
            .insert({
              meeting_id: id,
              transcript: sentences[i],
              timestamp: timestamp,
              audio_start_time: startTime,
              audio_end_time: endTime,
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
      console.error('错误详情:', {
        message: whisperError.message,
        stack: whisperError.stack,
        name: whisperError.name
      })
      
      // 如果转录 API 失败，返回详细的错误信息
      return NextResponse.json({ 
        error: whisperError.message || 'Transcription service unavailable',
        details: process.env.NODE_ENV === 'development' 
          ? whisperError.stack 
          : '请检查 API 配置和网络连接',
        transcripts: []
      }, { status: 500 })
    }
  } catch (error: any) {
    console.error('Error in POST /api/meetings/[id]/transcribe:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
