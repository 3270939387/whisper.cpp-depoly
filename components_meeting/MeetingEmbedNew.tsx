'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Mic, Square, Pause, Play, Edit2, Save, History, Trash2, FileText, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import TranscriptView, { type ManualNote } from './TranscriptView'
import AISummary from './AISummary'
import LanguageSelection from './LanguageSelection'
import type { Meeting, Transcript, SummaryProcess, LLMConfig } from '@/types/meeting'
import { getLanguagePreference, type TranscriptionLanguage } from '@/utils/transcription-language'
import { WAVRecorder } from '@/utils/wavEncoder'

export default function MeetingEmbedNew() {
  // 会议状态
  const [currentMeeting, setCurrentMeeting] = useState<Meeting | null>(null)
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [summary, setSummary] = useState<SummaryProcess | null>(null)
  const [manualNotes, setManualNotes] = useState<ManualNote[]>([])
  
  // 录音状态
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const [audioLevels, setAudioLevels] = useState<number[]>([])
  const [noteTitle, setNoteTitle] = useState('New Note')
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [transcriptionLanguage, setTranscriptionLanguage] = useState<TranscriptionLanguage>('auto')
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isSilentDetected, setIsSilentDetected] = useState(false)
  const [isUploadingFile, setIsUploadingFile] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  
  // 视图状态：false = 录音页面，true = 双栏布局（原文+总结）
  const [showSummaryView, setShowSummaryView] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [historyMeetings, setHistoryMeetings] = useState<Meeting[]>([])
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [editingMeetingId, setEditingMeetingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState<string>('')
  
  // Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const wavRecorderRef = useRef<WAVRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const transcriptionIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const lastTranscriptionTimeRef = useRef<number>(0) // 上次转录的时间点
  const transcriptionChunksRef = useRef<Blob[]>([]) // 用于实时转录的音频片段（滑动窗口，保存最近8秒）
  const transcriptionWindowRef = useRef<Blob[]>([]) // 滑动窗口缓冲区（保存最近8秒的音频）
  const lastProcessedTimeRef = useRef<number>(0) // 上次处理的时间点（用于增量识别）
  const recordingTimeRef = useRef<number>(0) // 录音时间的 ref（用于在定时器中访问最新值）
  const isRecordingRef = useRef<boolean>(false) // 用于在定时器中访问最新状态
  const currentMeetingIdRef = useRef<string | null>(null) // 会议ID的 ref（用于在定时器中访问最新值）
  const isPausedRef = useRef<boolean>(false) // 用于在定时器中访问最新状态
  const transcriptionLanguageRef = useRef<TranscriptionLanguage>('auto') // 用于在定时器中访问最新语言设置
  const previousWindowTextRef = useRef<string>('') // 前一个窗口的完整文本（用于LCP增量提取）

  // 格式化时间
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  // 格式化时间戳
  const formatTimestamp = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`
  }

  // 计算最长公共前缀（LCP）用于增量文本提取
  const longestCommonPrefix = (str1: string, str2: string): string => {
    if (!str1 || !str2) return ''
    
    let i = 0
    const minLength = Math.min(str1.length, str2.length)
    
    // 逐字符比较，找到最长公共前缀
    while (i < minLength && str1[i] === str2[i]) {
      i++
    }
    
    // 为了更准确地匹配，尝试在词边界处截断
    // 这样可以避免在词中间截断
    let prefix = str1.substring(0, i)
    
    // 如果前缀不是以空格或标点结尾，尝试找到最近的词边界
    if (i < minLength && prefix.length > 0) {
      const lastSpaceIndex = prefix.lastIndexOf(' ')
      const lastPunctuationIndex = Math.max(
        prefix.lastIndexOf('。'),
        prefix.lastIndexOf('，'),
        prefix.lastIndexOf('、'),
        prefix.lastIndexOf('！'),
        prefix.lastIndexOf('？'),
        prefix.lastIndexOf('.'),
        prefix.lastIndexOf(','),
        prefix.lastIndexOf('!'),
        prefix.lastIndexOf('?')
      )
      const boundaryIndex = Math.max(lastSpaceIndex, lastPunctuationIndex)
      
      if (boundaryIndex > prefix.length * 0.5) {
        // 如果词边界在中间位置之后，使用词边界
        prefix = prefix.substring(0, boundaryIndex + 1)
      }
    }
    
    return prefix
  }

  // 创建新会议
  const createMeeting = async (title: string) => {
    try {
      const response = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      })
      
      if (!response.ok) throw new Error('Failed to create meeting')
      
      const { meeting } = await response.json()
      setCurrentMeeting(meeting)
      return meeting
    } catch (error: any) {
      console.error('Error creating meeting:', error)
      toast.error(error.message || 'Failed to create meeting')
      return null
    }
  }

  // 加载会议数据
  const loadMeetingData = async (meetingId: string) => {
    try {
      // 加载转录
      const transcriptsRes = await fetch(`/api/meetings/${meetingId}/transcripts`)
      if (transcriptsRes.ok) {
        const { transcripts: ts } = await transcriptsRes.json()
        setTranscripts(ts || [])
      }

      // 加载摘要（默认加载 standard 模板）
      const summaryRes = await fetch(`/api/meetings/${meetingId}/summary?template_id=standard`)
      if (summaryRes.ok) {
        const { summary: s } = await summaryRes.json()
        setSummary(s)
      }
    } catch (error) {
      console.error('Error loading meeting data:', error)
    }
  }

  // 加载历史会议列表
  const loadHistoryMeetings = useCallback(async () => {
    setIsLoadingHistory(true)
    try {
      const response = await fetch('/api/meetings')
      if (response.ok) {
        const { meetings } = await response.json()
        // 只显示已完成的会议
        const completedMeetings = (meetings || []).filter(
          (m: Meeting) => m.status === 'completed'
        )
        setHistoryMeetings(completedMeetings)
      } else {
        console.error('Failed to load history meetings')
        setHistoryMeetings([])
      }
    } catch (error) {
      console.error('Error loading history meetings:', error)
      setHistoryMeetings([])
    } finally {
      setIsLoadingHistory(false)
    }
  }, [])

  // 加载指定会议
  const loadMeeting = useCallback(async (meetingId: string) => {
    try {
      const response = await fetch(`/api/meetings/${meetingId}`)
      if (response.ok) {
        const { meeting } = await response.json()
        setCurrentMeeting(meeting)
        setNoteTitle(meeting.title)
        await loadMeetingData(meetingId)
        setShowHistory(false)
        setShowSummaryView(true)
        // 通知sidebar关闭历史视图
        window.dispatchEvent(new CustomEvent('meeting-history-toggle', {
          detail: { show: false }
        }))
        toast.success('Meeting loaded')
      } else {
        toast.error('Failed to load meeting')
      }
    } catch (error) {
      console.error('Error loading meeting:', error)
      toast.error('Failed to load meeting')
    }
  }, [])

  // 删除会议
  const deleteMeeting = useCallback(async (meetingId: string, event: React.MouseEvent) => {
    event.stopPropagation() // 阻止触发卡片点击事件
    
    if (!confirm('Are you sure you want to delete this meeting? This action cannot be undone.')) {
      return
    }

    try {
      const response = await fetch(`/api/meetings/${meetingId}`, {
        method: 'DELETE',
      })

      if (response.ok) {
        toast.success('Meeting deleted')
        // 从列表中移除
        setHistoryMeetings(prev => prev.filter(m => m.id !== meetingId))
        // 如果当前正在查看这个会议，重置状态
        if (currentMeeting?.id === meetingId) {
          setCurrentMeeting(null)
          setShowSummaryView(false)
          setTranscripts([])
          setSummary(null)
        }
      } else {
        toast.error('Failed to delete meeting')
      }
    } catch (error) {
      console.error('Error deleting meeting:', error)
      toast.error('Failed to delete meeting')
    }
  }, [currentMeeting])

  // 开始编辑会议标题
  const startEditingTitle = useCallback((meeting: Meeting, event: React.MouseEvent) => {
    event.stopPropagation() // 阻止触发卡片点击事件
    setEditingMeetingId(meeting.id)
    setEditingTitle(meeting.title)
  }, [])

  // 保存会议标题
  const saveMeetingTitle = useCallback(async (meetingId: string, event?: React.MouseEvent | React.KeyboardEvent) => {
    if (event) {
      event.stopPropagation()
    }

    if (!editingTitle.trim()) {
      toast.error('Title cannot be empty')
      return
    }

    try {
      const response = await fetch(`/api/meetings/${meetingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: editingTitle.trim() })
      })

      if (response.ok) {
        const { meeting } = await response.json()
        // 更新列表中的会议标题
        setHistoryMeetings(prev => 
          prev.map(m => m.id === meetingId ? meeting : m)
        )
        // 如果当前正在查看这个会议，也更新标题
        if (currentMeeting?.id === meetingId) {
          setCurrentMeeting(meeting)
          setNoteTitle(meeting.title)
        }
        setEditingMeetingId(null)
        setEditingTitle('')
        toast.success('Title updated')
      } else {
        toast.error('Failed to update title')
      }
    } catch (error) {
      console.error('Error updating title:', error)
      toast.error('Failed to update title')
    }
  }, [editingTitle, currentMeeting])

  // 取消编辑
  const cancelEditing = useCallback((event?: React.MouseEvent | React.KeyboardEvent) => {
    if (event) {
      event.stopPropagation()
    }
    setEditingMeetingId(null)
    setEditingTitle('')
  }, [])

  // 开始录音
  const startRecording = useCallback(async () => {
    try {
      // 如果没有会议，先创建一个
      let meetingToUse = currentMeeting
      if (!meetingToUse) {
        const meeting = await createMeeting(noteTitle)
        if (!meeting) return
        setCurrentMeeting(meeting)
        currentMeetingIdRef.current = meeting.id // 同步更新 ref
        meetingToUse = meeting
      } else {
        currentMeetingIdRef.current = meetingToUse.id // 同步更新 ref
      }

      // 请求麦克风权限
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // 使用 WAV 录音器（whisper.cpp 原生支持）
      console.log('🎙️ 使用 WAV 格式录音（16kHz, 单声道, whisper.cpp 原生支持）')
      
      const wavRecorder = new WAVRecorder(16000) // 16kHz 采样率（Whisper 推荐）
      await wavRecorder.start(stream)
      wavRecorderRef.current = wavRecorder
      
      // 仍然创建 MediaRecorder 用于音频可视化（但不用于录音）
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      })
      mediaRecorderRef.current = mediaRecorder
      audioChunksRef.current = []

      // 设置音频分析器
      const audioContext = new AudioContext()
      const analyser = audioContext.createAnalyser()
      const source = audioContext.createMediaStreamSource(stream)
      source.connect(analyser)
      analyser.fftSize = 256
      
      audioContextRef.current = audioContext
      analyserRef.current = analyser

      // 分析音频级别
      const analyzeAudio = () => {
        if (!analyserRef.current) return
        
        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount)
        analyserRef.current.getByteFrequencyData(dataArray)
        
        const bars = 12
        const step = Math.floor(dataArray.length / bars)
        const levels: number[] = []
        
        for (let i = 0; i < bars; i++) {
          const index = i * step
          const value = dataArray[index] / 255
          levels.push(Math.max(0.1, value))
        }
        
        setAudioLevels(levels)
        animationFrameRef.current = requestAnimationFrame(analyzeAudio)
      }
      analyzeAudio()

      // 处理录音数据
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
          // 保存到滑动窗口缓冲区（用于重叠识别）
          transcriptionWindowRef.current.push(event.data)
          
          // 限制滑动窗口大小为约9秒（chunk = 3秒，保留最近3个）
          // 9秒窗口可以确保 Whisper 有足够的上下文来识别中文
          // chunk 3秒 + 窗口9秒 = 3个chunk，这样每次发送的音频更稳定
          const maxWindowChunks = 3 // 约9秒的音频（3个3秒chunk）
          if (transcriptionWindowRef.current.length > maxWindowChunks) {
            transcriptionWindowRef.current.shift() // 移除最旧的chunk
          }
          
          console.log('🎵 音频数据已添加到滑动窗口:', {
            chunkSize: `${(event.data.size / 1024).toFixed(2)} KB`,
            windowSize: transcriptionWindowRef.current.length,
            totalSize: `${(transcriptionWindowRef.current.reduce((sum, chunk) => sum + chunk.size, 0) / 1024).toFixed(2)} KB`
          })
        }
      }

      // 开始录音
      // chunk 时长改为 3 秒，确保 Whisper 有足够的上下文识别中文
      // 2 秒的 chunk 仍然可能太短，导致后续内容无法识别
      // 3 秒的 chunk 可以提供更稳定的识别结果
      mediaRecorder.start(3000) // 每3秒收集一次数据
      setIsRecording(true)
      setIsPaused(false)
      isRecordingRef.current = true
      isPausedRef.current = false
      setRecordingTime(0)
      recordingTimeRef.current = 0 // 重置录音时间 ref
      setShowSummaryView(false) // 录音时显示录音页面
      setTranscripts([]) // 重置转录列表
      setIsSilentDetected(false) // 重置静音检测状态
      setSummary(null) // 清除旧的摘要
      lastTranscriptionTimeRef.current = 0 // 重置转录时间

      // 开始计时
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => {
          const newTime = prev + 1
          recordingTimeRef.current = newTime // 同步更新 ref
          return newTime
        })
      }, 1000)

      // 实时转录已禁用 - 只在录音结束后进行完整转录
      // 保留相关 ref 的初始化以供录音结束后的转录使用
      lastTranscriptionTimeRef.current = 0
      lastProcessedTimeRef.current = 0
      transcriptionWindowRef.current = []
      previousWindowTextRef.current = ''
      isRecordingRef.current = true
      isPausedRef.current = false
      
      console.log('🎙️ 录音开始，会议ID:', meetingToUse?.id, '(实时转录已禁用)')

      // 清理转录定时器
      mediaRecorder.onstop = async () => {
        isRecordingRef.current = false
        if (transcriptionIntervalRef.current) {
          clearInterval(transcriptionIntervalRef.current)
          transcriptionIntervalRef.current = null
        }
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current)
        }
        if (audioContextRef.current) {
          await audioContextRef.current.close()
        }
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop())
        }
        setAudioLevels([])
        
        // 转录最后剩余的音频片段（滑动窗口中的内容）
        const finalMeetingId = currentMeetingIdRef.current
        if (transcriptionWindowRef.current.length > 0 && finalMeetingId) {
          try {
            const audioBlob = new Blob(transcriptionWindowRef.current, { type: 'audio/webm' })
            const windowStartTime = Math.max(0, recordingTimeRef.current - 9)
            const formData = new FormData()
            formData.append('audio', audioBlob, 'recording-segment.webm')
            formData.append('startTime', windowStartTime.toString())
            formData.append('windowStartTime', windowStartTime.toString())
            formData.append('lastProcessedTime', lastProcessedTimeRef.current.toString())
            formData.append('language', transcriptionLanguageRef.current)
            
            const response = await fetch(`/api/meetings/${finalMeetingId}/transcribe-live`, {
              method: 'POST',
              body: formData,
            })
            
            if (response.ok) {
              const data = await response.json()
              const newTranscripts = data.transcripts || []
              const message = data.message || ''
              
              // 如果是静音检测，跳过处理
              if (message === 'no recording detected') {
                console.log('🔇 最终转录：检测到静音片段，跳过')
                return
              }
              
              if (newTranscripts && newTranscripts.length > 0) {
                setTranscripts(prev => {
                  const result = [...prev]
                  
                  for (const newTranscript of newTranscripts) {
                    // 只处理上次处理时间之后的新转录
                    if (newTranscript.audio_start_time <= lastProcessedTimeRef.current) {
                      continue
                    }
                    
                    // 检查是否有时间重叠的已有转录
                    const hasOverlap = result.some(existing => {
                      const timeOverlap = Math.abs(existing.audio_start_time - newTranscript.audio_start_time) < 1.0
                      const textSimilar = existing.transcript === newTranscript.transcript ||
                                        existing.transcript.includes(newTranscript.transcript) ||
                                        newTranscript.transcript.includes(existing.transcript)
                      return timeOverlap && textSimilar
                    })
                    
                    if (!hasOverlap) {
                      result.push(newTranscript)
                    }
                  }
                  
                  // 按时间排序
                  result.sort((a, b) => a.audio_start_time - b.audio_start_time)
                  
                  return result
                })
              }
            }
          } catch (error) {
            console.error('Final transcription error:', error)
          }
        }
        
        transcriptionChunksRef.current = []
      }

      toast.success('Recording started')
    } catch (error) {
      console.error('Failed to start recording:', error)
      toast.error('Failed to access microphone. Please check permissions.')
      setIsRecording(false)
    }
  }, [currentMeeting, noteTitle])

  // 停止录音
  const stopRecording = useCallback(async () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
      setIsPaused(false)
      isRecordingRef.current = false
      isPausedRef.current = false

      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }

      // 停止 WAV 录音器并获取 WAV 数据
      const audioBlob = wavRecorderRef.current?.stop() || new Blob([], { type: 'audio/wav' })
      
      console.log('✅ WAV 录音完成:', {
        size: `${(audioBlob.size / 1024 / 1024).toFixed(2)} MB`,
        type: audioBlob.type,
        duration: `${recordingTime}s`
      })
      
      // 自动保存录音文件到本地
      if (audioBlob.size > 0) {
        try {
          // 生成文件名：会议标题_时间戳.wav
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5) // 格式：2024-01-01T12-00-00
          const safeTitle = (noteTitle || 'Recording').replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').slice(0, 50) // 清理标题，限制长度
          const fileName = `${safeTitle}_${timestamp}.wav`
          
          // 创建下载链接
          const url = URL.createObjectURL(audioBlob)
          const link = document.createElement('a')
          link.href = url
          link.download = fileName
          link.style.display = 'none'
          document.body.appendChild(link)
          
          // 触发下载
          link.click()
          
          // 清理
          setTimeout(() => {
            document.body.removeChild(link)
            URL.revokeObjectURL(url)
          }, 100)
          
          console.log('💾 录音文件已保存到本地:', fileName)
          toast.success(`Recording saved as ${fileName}`)
        } catch (saveError: any) {
          console.error('❌ 保存录音文件失败:', saveError)
          toast.error('Failed to save recording file')
        }
      }
      
      if (!currentMeeting) {
        toast.error('No meeting found')
        return
      }

      toast.success('Recording stopped. Processing transcription...')
      setIsTranscribing(true) // 设置转录状态
      
      try {
        // 判断是否需要上传到 Blob Storage（大于 4MB）
        const MAX_INLINE_AUDIO_SIZE_MB = 4
        const audioSizeMB = audioBlob.size / (1024 * 1024)
        
        // 创建直接上传的 FormData 辅助函数
        const createDirectUploadFormData = (): FormData => {
          const formData = new FormData()
          formData.append('audio', audioBlob, 'recording.wav')
          formData.append('language', transcriptionLanguage)
          formData.append('audioDuration', recordingTime.toString())
          return formData
        }
        
        let audioPayload: FormData | { audioUrl: string; audioDuration: string; language: string }

        if (audioSizeMB > MAX_INLINE_AUDIO_SIZE_MB) {
          console.log(`📤 Recording size (${audioSizeMB.toFixed(2)} MB) exceeds ${MAX_INLINE_AUDIO_SIZE_MB} MB, uploading to Blob Storage...`)
          const uploadFormData = new FormData()
          uploadFormData.append('file', audioBlob, 'recording.wav')
          
          try {
            const uploadResponse = await fetch('/api/upload', {
              method: 'POST',
              body: uploadFormData,
            })
            
            if (uploadResponse.ok) {
              const uploadData = await uploadResponse.json()
              
              // 检查响应格式
              if (uploadData.url && !uploadData.url.startsWith('data:')) {
                // 成功上传到 Blob Storage（不是 base64 data URL）
                audioPayload = {
                  audioUrl: uploadData.url,
                  audioDuration: recordingTime.toString(),
                  language: transcriptionLanguage
                }
                console.log('✅ Recording uploaded to Blob Storage:', uploadData.url)
              } else {
                // base64 data URL（Blob Storage 未配置），回退到直接上传
                console.warn('⚠️ Blob Storage not configured. File too large for direct upload.')
                toast.error('Recording too large. Please configure Blob Storage or reduce recording length.')
                setIsTranscribing(false)
                return
              }
            } else {
              // 上传失败
              const errorData = await uploadResponse.json().catch(() => ({}))
              console.error('❌ Blob Storage upload failed:', errorData.error || uploadResponse.statusText)
              toast.error('Failed to upload large recording. Please try a shorter recording.')
              setIsTranscribing(false)
              return
            }
          } catch (uploadError: any) {
            // 上传异常
            console.error('❌ Blob Storage upload error:', uploadError.message)
            toast.error('Failed to upload recording. Please try again.')
            setIsTranscribing(false)
            return
          }
        } else {
          // 文件小于等于 4MB，直接上传
          console.log(`📤 Recording size (${audioSizeMB.toFixed(2)} MB) is within limit, sending directly.`)
          audioPayload = createDirectUploadFormData()
        }

        // 调用转录 API
        const response = await fetch(`/api/meetings/${currentMeeting.id}/transcribe`, {
          method: 'POST',
          body: audioPayload instanceof FormData ? audioPayload : JSON.stringify(audioPayload),
          headers: audioPayload instanceof FormData ? {} : { 'Content-Type': 'application/json' },
        })
        
        if (response.ok) {
          const data = await response.json()
          const newTranscripts = data.transcripts || []
          const message = data.message || ''
          
          // 检查是否为静音检测
          if (message === 'no recording detected') {
            setIsSilentDetected(true)
            toast.warning('No recording detected - audio appears to be silent')
            // 静音时不调用 LLM 生成摘要
            setSummary(null)
            setShowSummaryView(true)
            return
          } else {
            setIsSilentDetected(false)
          }
          
          if (newTranscripts.length > 0) {
            setTranscripts(prev => [...prev, ...newTranscripts])
          }
          
          // 更新会议状态
          const updateResponse = await fetch(`/api/meetings/${currentMeeting.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              status: 'completed',
              audio_duration: recordingTime 
            })
          })
          
          if (updateResponse.ok) {
            const { meeting: updatedMeeting } = await updateResponse.json()
            setCurrentMeeting(updatedMeeting)
            // 如果正在显示历史视图，刷新历史列表
            if (showHistory) {
              loadHistoryMeetings()
            }
          }
          
          if (newTranscripts.length > 0) {
            toast.success('Transcription completed')
            
            // 停止录制后切换到双栏布局
            setSummary(null) // 清除旧的摘要（新录音还没有生成摘要）
            setShowSummaryView(true)

            // 只有在有转录文本时才自动生成摘要
            // 自动生成一次默认的会议总结：使用 'default' 模板（不使用任何自定义模板），默认英文
            try {
              await handleGenerateSummary('default', undefined, 'en', false)
            } catch (e) {
              console.error('Auto-generate summary failed:', e)
            }
          } else {
            toast.warning('Transcription completed but no text was extracted')
            // 没有转录文本时，不调用 LLM
            setSummary(null)
            setShowSummaryView(true)
          }
        } else {
          // 尝试解析错误信息
          let errorMessage = 'Transcription failed'
          try {
            const errorData = await response.json()
            errorMessage = errorData.error || errorData.details || errorData.message || errorMessage
            console.error('Transcription API error:', {
              status: response.status,
              statusText: response.statusText,
              error: errorData
            })
          } catch (parseError) {
            console.error('Failed to parse error response:', parseError)
            errorMessage = `Transcription failed (HTTP ${response.status})`
          }
          
          toast.error(errorMessage)
          console.error('Transcription failed:', errorMessage)
          
          // 即使转录失败，也切换到双栏布局，允许用户查看已有的转录
          setSummary(null) // 清除旧的摘要
          setShowSummaryView(true)
        }
      } catch (error: any) {
        console.error('Transcription error:', error)
        const errorMessage = error.message || 'Transcription service unavailable'
        toast.error(errorMessage)
        // 即使转录失败，也切换到双栏布局
        setSummary(null) // 清除旧的摘要
        setShowSummaryView(true)
      } finally {
        setIsTranscribing(false) // 无论成功或失败，都清除转录状态
      }
    }
  }, [isRecording, recordingTime, currentMeeting, showHistory, loadHistoryMeetings])

  // 暂停/恢复录音
  const togglePause = useCallback(() => {
    if (!mediaRecorderRef.current) return

    if (isPaused) {
      mediaRecorderRef.current.resume()
      setIsPaused(false)
      isPausedRef.current = false
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1)
      }, 1000)
      toast.info('Recording resumed')
    } else {
      mediaRecorderRef.current.pause()
      setIsPaused(true)
      isPausedRef.current = true
      if (timerRef.current) {
        clearInterval(timerRef.current)
      }
      // 暂停时也暂停转录定时器（通过isPaused检查）
      toast.info('Recording paused')
    }
  }, [isPaused])

  // 处理文件上传
  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    // 验证文件类型
    const validAudioTypes = ['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/webm', 'audio/ogg', 'audio/m4a', 'audio/aac']
    const isValidType = validAudioTypes.includes(file.type) || 
                       /\.(wav|mp3|m4a|ogg|webm|aac)$/i.test(file.name)
    
    if (!isValidType) {
      toast.error('Please select a valid audio file (WAV, MP3, M4A, OGG, WEBM, AAC)')
      return
    }

    // 验证文件大小（最大 100MB）
    const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB
    if (file.size > MAX_FILE_SIZE) {
      toast.error(`File size exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`)
      return
    }

    // 如果没有会议，先创建一个
    if (!currentMeeting) {
      const meeting = await createMeeting(noteTitle)
      if (!meeting) return
      setCurrentMeeting(meeting)
    }

    // 开始处理文件
    setIsUploadingFile(true)
    setIsTranscribing(true)
    toast.info('Uploading audio file...')

    try {
      await handleTranscribeUploadedFile(file)
    } catch (error: any) {
      console.error('File upload error:', error)
      toast.error(error.message || 'Failed to upload and transcribe file')
      setIsUploadingFile(false)
      setIsTranscribing(false)
    } finally {
      // 重置文件输入
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }, [currentMeeting, noteTitle])

  // 生成摘要
  // useTemplate: 是否使用自定义模板（默认 true）；false 时使用 DeepSeek 默认提示词（通用结构总结）
  // language: 摘要输出语言（默认 'en'）
  const handleGenerateSummary = async (
    templateId?: string,
    contextPrompt?: string,
    language?: string,
    useTemplate: boolean = true
  ) => {
    if (!currentMeeting) {
      toast.error('No meeting found')
      return
    }

    try {
      const response = await fetch(`/api/meetings/${currentMeeting.id}/summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: templateId || 'default',
          context_prompt: contextPrompt,
          language: language || 'en',
          use_template: useTemplate,
        }),
      })

      if (!response.ok) throw new Error('Failed to generate summary')

      const { summary: newSummary } = await response.json()
      setSummary(newSummary)

      // 轮询摘要状态（使用生成时传入的模板 ID，确保轮询的是正确的模板）
      const actualTemplateId = templateId || 'default'
      const pollSummary = async () => {
        const res = await fetch(`/api/meetings/${currentMeeting.id}/summary?template_id=${actualTemplateId}`)
        if (res.ok) {
          const { summary: s } = await res.json()
          // 只有当轮询到的摘要属于当前请求的模板时，才更新状态
          // 避免轮询到其他模板的摘要导致界面跳转
          if (s && (!s.template_id || s.template_id === actualTemplateId)) {
            setSummary(s)
            if (s?.status === 'processing') {
              setTimeout(pollSummary, 2000)
            }
          } else if (!s) {
            // 如果返回 null，说明该模板还没有生成完成，继续轮询
            setTimeout(pollSummary, 2000)
          }
        }
      }
      setTimeout(pollSummary, 2000)
    } catch (error: any) {
      toast.error(error.message || 'Failed to generate summary')
    }
  }

  // 处理上传文件的转录
  const handleTranscribeUploadedFile = useCallback(async (audioFile: File) => {
    if (!currentMeeting) {
      throw new Error('No meeting found')
    }

    try {
      // 获取音频时长（如果可能）
      let audioDuration: number | null = null
      try {
        const audio = new Audio()
        const url = URL.createObjectURL(audioFile)
        await new Promise<void>((resolve, reject) => {
          audio.onloadedmetadata = () => {
            audioDuration = audio.duration
            URL.revokeObjectURL(url)
            resolve()
          }
          audio.onerror = reject
          audio.src = url
        })
      } catch (e) {
        console.warn('Could not determine audio duration:', e)
      }

      // 判断是否需要上传到 Blob Storage（大于 4MB）
      const MAX_INLINE_AUDIO_SIZE_MB = 4
      const audioSizeMB = audioFile.size / (1024 * 1024)
      
      // 创建直接上传的 FormData 辅助函数
      const createDirectUploadFormData = (): FormData => {
        const formData = new FormData()
        formData.append('audio', audioFile, audioFile.name)
        formData.append('language', transcriptionLanguage)
        formData.append('audioDuration', (audioDuration ?? 0).toString())
        return formData
      }
      
      let audioPayload: FormData | { audioUrl: string; audioDuration: string; language: string }

      if (audioSizeMB > MAX_INLINE_AUDIO_SIZE_MB) {
        console.log(`📤 Audio file size (${audioSizeMB.toFixed(2)} MB) exceeds ${MAX_INLINE_AUDIO_SIZE_MB} MB, attempting to upload to Blob Storage...`)
        const uploadFormData = new FormData()
        uploadFormData.append('file', audioFile, audioFile.name)
        
        try {
          const uploadResponse = await fetch('/api/upload', {
            method: 'POST',
            body: uploadFormData,
          })
          
          if (uploadResponse.ok) {
            const uploadData = await uploadResponse.json()
            
            // 检查响应格式
            if (uploadData.url && !uploadData.url.startsWith('data:')) {
              // 成功上传到 Blob Storage（不是 base64 data URL）
              audioPayload = {
                audioUrl: uploadData.url,
                audioDuration: (audioDuration ?? 0).toString(),
                language: transcriptionLanguage
              }
              console.log('✅ Audio uploaded to Blob Storage:', uploadData.url)
            } else {
              // base64 data URL（Blob Storage 未配置），回退到直接上传
              console.warn('⚠️ Blob Storage not configured, received base64 data URL. Falling back to direct upload.')
              audioPayload = createDirectUploadFormData()
            }
          } else {
            // 上传失败，回退到直接上传
            const errorData = await uploadResponse.json().catch(() => ({}))
            console.warn('⚠️ Blob Storage upload failed, falling back to direct upload:', errorData.error || uploadResponse.statusText)
            audioPayload = createDirectUploadFormData()
          }
        } catch (uploadError: any) {
          // 上传异常，回退到直接上传
          console.warn('⚠️ Blob Storage upload error, falling back to direct upload:', uploadError.message)
          audioPayload = createDirectUploadFormData()
        }
      } else {
        // 文件小于等于 4MB，直接上传
        console.log(`📤 Audio file size (${audioSizeMB.toFixed(2)} MB) is within limit, sending directly.`)
        audioPayload = createDirectUploadFormData()
      }

      // 调用转录 API
      const response = await fetch(`/api/meetings/${currentMeeting.id}/transcribe`, {
        method: 'POST',
        body: audioPayload instanceof FormData ? audioPayload : JSON.stringify(audioPayload),
        headers: audioPayload instanceof FormData ? {} : { 'Content-Type': 'application/json' },
      })

      if (!response.ok) {
        let errorMessage = 'Transcription failed'
        try {
          const errorData = await response.json()
          errorMessage = errorData.error || errorData.details || errorData.message || errorMessage
        } catch (e) {
          errorMessage = `Transcription failed (HTTP ${response.status})`
        }
        throw new Error(errorMessage)
      }

      const data = await response.json()
      const newTranscripts = data.transcripts || []
      const message = data.message || ''

      // 检查是否为静音检测
      if (message === 'no recording detected') {
        setIsSilentDetected(true)
        toast.warning('No recording detected - audio appears to be silent')
        setSummary(null)
        setShowSummaryView(true)
        setIsUploadingFile(false)
        setIsTranscribing(false)
        return
      } else {
        setIsSilentDetected(false)
      }

      if (newTranscripts.length > 0) {
        setTranscripts(prev => [...prev, ...newTranscripts])
      }

      // 更新会议状态
      const updateResponse = await fetch(`/api/meetings/${currentMeeting.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          status: 'completed',
          audio_duration: audioDuration || 0
        })
      })

      if (updateResponse.ok) {
        const { meeting: updatedMeeting } = await updateResponse.json()
        setCurrentMeeting(updatedMeeting)
        if (showHistory) {
          loadHistoryMeetings()
        }
      }

      if (newTranscripts.length > 0) {
        toast.success('Transcription completed')
        setSummary(null)
        setShowSummaryView(true)

        // 自动生成摘要
        try {
          await handleGenerateSummary('default', undefined, 'en', false)
        } catch (e) {
          console.error('Auto-generate summary failed:', e)
        }
      } else {
        toast.warning('Transcription completed but no text was extracted')
        setSummary(null)
        setShowSummaryView(true)
      }

      setIsUploadingFile(false)
      setIsTranscribing(false)
    } catch (error: any) {
      console.error('Transcription error:', error)
      toast.error(error.message || 'Failed to transcribe audio file')
      setIsUploadingFile(false)
      setIsTranscribing(false)
      setSummary(null)
      setShowSummaryView(true)
    }
  }, [currentMeeting, transcriptionLanguage, showHistory, loadHistoryMeetings, handleGenerateSummary])

  // 保存摘要（现在由 AISummary 组件内部处理，这里保留以保持接口兼容）
  const handleSaveSummary = async (content: string) => {
    // 这个函数现在由 AISummary 组件内部处理，保留以保持接口兼容
    // 实际保存逻辑在 AISummary 组件中
  }

  // 保存标题
  const handleSaveTitle = async () => {
    setIsEditingTitle(false)
    if (currentMeeting && noteTitle.trim()) {
      try {
        await fetch(`/api/meetings/${currentMeeting.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: noteTitle })
        })
        toast.success('Title saved')
      } catch (error) {
        toast.error('Failed to save title')
      }
    }
  }

  // 监听sidebar的录音事件
  useEffect(() => {
    const handleRecordingToggle = (event: CustomEvent) => {
      if (event.detail.start && !isRecording) {
        startRecording()
      } else if (!event.detail.start && isRecording) {
        stopRecording()
      }
    }

    window.addEventListener('meeting-recording-toggle', handleRecordingToggle as EventListener)
    return () => {
      window.removeEventListener('meeting-recording-toggle', handleRecordingToggle as EventListener)
    }
  }, [isRecording, startRecording, stopRecording])

  // 通知sidebar录音状态变化
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('meeting-recording-state', {
      detail: { isRecording }
    }))
  }, [isRecording])

  // 监听历史视图切换
  useEffect(() => {
    const handleHistoryToggle = (event: CustomEvent) => {
      const shouldShow = event.detail.show
      setShowHistory(shouldShow)
      if (shouldShow) {
        loadHistoryMeetings()
      }
    }

    window.addEventListener('meeting-history-toggle', handleHistoryToggle as EventListener)
    return () => {
      window.removeEventListener('meeting-history-toggle', handleHistoryToggle as EventListener)
    }
  }, [loadHistoryMeetings])

  // 同步会议ID到ref（确保定时器可以访问最新的会议ID）
  useEffect(() => {
    currentMeetingIdRef.current = currentMeeting?.id || null
  }, [currentMeeting?.id])

  // 加载会议数据
  useEffect(() => {
    if (currentMeeting?.id) {
      loadMeetingData(currentMeeting.id)
    }
  }, [currentMeeting?.id])

  // 加载语言偏好
  useEffect(() => {
    const saved = getLanguagePreference()
    setTranscriptionLanguage(saved)
    transcriptionLanguageRef.current = saved
  }, [])

  // 更新语言偏好 ref
  useEffect(() => {
    transcriptionLanguageRef.current = transcriptionLanguage
  }, [transcriptionLanguage])

  // 清理
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
      }
      if (transcriptionIntervalRef.current) {
        clearInterval(transcriptionIntervalRef.current)
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
      }
      if (audioContextRef.current) {
        audioContextRef.current.close()
      }
    }
  }, [])

  // 录音页面视图
  const renderRecordingView = () => (
    <div className="flex flex-col h-full max-w-4xl mx-auto w-full">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between p-4 border-b bg-white">
        <div className="flex items-center gap-4">
          {/* 语言选择 */}
          <LanguageSelection 
            onLanguageChange={(lang) => setTranscriptionLanguage(lang)}
          />
          
          {isEditingTitle ? (
            <div className="flex items-center gap-2">
              <Input
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                onBlur={handleSaveTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveTitle()
                  }
                }}
                className="text-xl font-semibold border-0 border-b-2 border-gray-300 focus:border-primary rounded-none px-0"
                autoFocus
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={handleSaveTitle}
                className="h-6 w-6"
              >
                <Save className="w-4 h-4" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 group">
              <h2 
                className="text-xl font-semibold text-gray-700 cursor-pointer hover:text-gray-900 transition-colors"
                onClick={() => setIsEditingTitle(true)}
              >
                {noteTitle}
              </h2>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsEditingTitle(true)}
                className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Edit2 className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* 录音时的转录文本显示（支持手动记录） */}
      {isRecording && (
        <div className="flex-1 overflow-hidden bg-white rounded-lg shadow-sm mx-4 my-2">
          <TranscriptView
            meetingId={currentMeeting?.id || ''}
            transcripts={transcripts}
            manualNotes={manualNotes}
            isTranscribing={false}
            isRecording={isRecording}
            recordingTime={recordingTime}
            onManualNoteAdd={(note) => setManualNotes(prev => [...prev, note])}
          />
        </div>
      )}

      {/* 录音控制区域 - 仅在录音时显示在底部 */}
      {isRecording && (
        <div className="border-t border-gray-200 pt-6 mt-auto">
          <div className="flex items-center justify-center gap-6">
            {/* 暂停按钮 */}
            <Button
              onClick={togglePause}
              variant="outline"
              size="lg"
              className="rounded-xl bg-gray-50 hover:bg-gray-100 border-gray-200 shadow-sm h-12 w-12 p-0"
            >
              {isPaused ? (
                <Play className="w-5 h-5 text-gray-700" />
              ) : (
                <Pause className="w-5 h-5 text-gray-700" />
              )}
            </Button>

            {/* 音频可视化器和时间 */}
            <div className="flex items-center gap-3">
              {/* 音频可视化器 */}
              <div className="flex items-end gap-1 h-10">
                {audioLevels.length > 0 ? (
                  audioLevels.map((level, index) => (
                    <div
                      key={index}
                      className="w-1.5 bg-blue-500 rounded-t transition-all duration-75"
                      style={{
                        height: `${Math.max(20, level * 100)}%`,
                        minHeight: '4px'
                      }}
                    />
                  ))
                ) : (
                  Array.from({ length: 12 }).map((_, index) => (
                    <div
                      key={index}
                      className="w-1.5 bg-blue-200 rounded-t"
                      style={{
                        height: '20%',
                        minHeight: '4px'
                      }}
                    />
                  ))
                )}
              </div>

              {/* 录音时间和状态 */}
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                <span className="text-blue-600 font-semibold text-lg">
                  {formatTime(recordingTime)}
                </span>
              </div>
            </div>

            {/* 结束按钮 */}
            <Button
              onClick={stopRecording}
              size="lg"
              className="rounded-xl bg-red-500 hover:bg-red-600 text-white px-6 h-12 shadow-sm font-medium"
            >
              End
            </Button>
          </div>
        </div>
      )}

      {/* 录音前：开始录音按钮和上传文件按钮 - 在最下面中间 */}
      {!isRecording && transcripts.length === 0 && (
        <div className="mt-auto pt-8 pb-12">
          <div className="flex flex-col items-center gap-4">
            {/* 开始录音按钮 */}
            <Button
              onClick={startRecording}
              size="lg"
              className="rounded-full w-20 h-20 bg-red-500 hover:bg-red-600 shadow-lg"
            >
              <Mic className="w-10 h-10 text-white" />
            </Button>
            
            {/* 分隔线 */}
            <div className="flex items-center gap-3 w-full max-w-xs">
              <div className="flex-1 h-px bg-gray-300"></div>
              <span className="text-sm text-gray-500">or</span>
              <div className="flex-1 h-px bg-gray-300"></div>
            </div>
            
            {/* 上传文件按钮 */}
            <div className="flex flex-col items-center gap-2">
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploadingFile || isTranscribing}
                size="lg"
                variant="outline"
                className="rounded-xl px-6 h-12 border-2 border-dashed border-gray-300 hover:border-blue-500 hover:bg-blue-50 transition-colors"
              >
                {isUploadingFile || isTranscribing ? (
                  <>
                    <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mr-2" />
                    Processing...
                  </>
                ) : (
                  <>
                    <Upload className="w-5 h-5 mr-2" />
                    Upload Audio File
                  </>
                )}
              </Button>
              <p className="text-xs text-gray-500 text-center max-w-xs">
                Support WAV, MP3, M4A, OGG, WEBM, AAC (max 100MB)
              </p>
            </div>
            
            {/* 隐藏的文件输入 */}
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm,.aac"
              onChange={handleFileUpload}
              className="hidden"
            />
          </div>
        </div>
      )}
    </div>
  )

  // 双栏布局视图（停止录制后显示）
  const renderSummaryView = () => (
    <div className="flex flex-col h-full">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between p-4 border-b bg-white">
        <div className="flex items-center gap-4">
          {/* 语言选择 */}
          <LanguageSelection 
            onLanguageChange={(lang) => setTranscriptionLanguage(lang)}
          />
          
          {isEditingTitle ? (
            <div className="flex items-center gap-2">
              <Input
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                onBlur={handleSaveTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveTitle()
                  }
                }}
                className="text-xl font-semibold border-0 border-b-2 border-gray-300 focus:border-primary rounded-none px-0"
                autoFocus
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={handleSaveTitle}
                className="h-6 w-6"
              >
                <Save className="w-4 h-4" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 group">
              <h2 
                className="text-xl font-semibold text-gray-700 cursor-pointer hover:text-gray-900 transition-colors"
                onClick={() => setIsEditingTitle(true)}
              >
                {noteTitle}
              </h2>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsEditingTitle(true)}
                className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Edit2 className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>

        <Button
          onClick={() => {
            setShowSummaryView(false)
            setTranscripts([])
            setSummary(null)
            setCurrentMeeting(null)
            setNoteTitle('New Note')
            setManualNotes([]) // 清除之前的 user highlights
            setShowHistory(false)
            // 通知sidebar关闭历史视图
            window.dispatchEvent(new CustomEvent('meeting-history-toggle', {
              detail: { show: false }
            }))
          }}
          size="sm"
          variant="outline"
          className="rounded-lg"
        >
          <Mic className="w-4 h-4 mr-2" />
          New Recording
        </Button>
      </div>

      {/* 双栏布局 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧：转录文本 */}
        <div className="w-1/2 border-r bg-white">
          <TranscriptView
            meetingId={currentMeeting?.id || ''}
            transcripts={transcripts}
            manualNotes={manualNotes}
            isTranscribing={isTranscribing}
            isRecording={isRecording}
            recordingTime={recordingTime}
            onManualNoteAdd={(note) => setManualNotes(prev => [...prev, note])}
          />
        </div>

        {/* 右侧：AI 总结 */}
        <div className="w-1/2 bg-white">
          <AISummary
            meetingId={currentMeeting?.id || ''}
            summary={summary}
            onGenerate={handleGenerateSummary}
            onSave={handleSaveSummary}
            isRecording={false}
          />
        </div>
      </div>
    </div>
  )

  // 历史记录视图
  const renderHistoryView = () => (
    <div className="flex flex-col h-full max-w-4xl mx-auto w-full">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between p-4 border-b bg-white">
        <div className="flex items-center gap-2">
          <History className="w-5 h-5 text-gray-600" />
          <h2 className="text-xl font-semibold text-gray-700">Meeting History</h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setShowHistory(false)
            window.dispatchEvent(new CustomEvent('meeting-history-toggle', {
              detail: { show: false }
            }))
          }}
        >
          Close
        </Button>
      </div>

      {/* 历史记录列表 */}
      <div className="flex-1 overflow-auto p-6">
        {isLoadingHistory ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-400">Loading history...</p>
          </div>
        ) : historyMeetings.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <History className="w-16 h-16 mb-4 opacity-50" />
            <p className="text-lg">No meeting history</p>
            <p className="text-sm mt-2">Your completed meetings will appear here</p>
          </div>
        ) : (
          <div className="space-y-3">
            {historyMeetings.map((meeting) => (
              <div
                key={meeting.id}
                onClick={() => {
                  if (editingMeetingId !== meeting.id) {
                    loadMeeting(meeting.id)
                  }
                }}
                className="p-4 border border-gray-200 rounded-lg hover:border-blue-300 hover:shadow-md transition-all cursor-pointer bg-white"
              >
                <div className="flex items-start justify-between gap-4">
                  {/* 左侧：图标和内容 */}
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
                      <FileText className="w-5 h-5 text-gray-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      {editingMeetingId === meeting.id ? (
                        <Input
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              saveMeetingTitle(meeting.id, e)
                            } else if (e.key === 'Escape') {
                              cancelEditing(e)
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={() => {
                            if (editingTitle.trim() && editingTitle !== meeting.title) {
                              saveMeetingTitle(meeting.id)
                            } else {
                              cancelEditing()
                            }
                          }}
                          className="font-semibold text-gray-800 mb-2"
                          autoFocus
                        />
                      ) : (
                        <h3 className="font-semibold text-gray-800 truncate mb-2">
                          {meeting.title}
                        </h3>
                      )}
                      <div className="flex items-center gap-4 text-sm text-gray-500">
                        <span>
                          {new Date(meeting.created_at).toLocaleString()}
                        </span>
                        {meeting.audio_duration && (
                          <span>
                            Duration: {formatTime(meeting.audio_duration)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 右侧：操作按钮 */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {editingMeetingId === meeting.id ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => saveMeetingTitle(meeting.id, e)}
                        className="h-8 w-8 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                      >
                        <Save className="w-4 h-4" />
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={(e) => startEditingTitle(meeting, e)}
                          className="h-8 w-8 text-gray-600 hover:text-gray-700 hover:bg-gray-50"
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={(e) => deleteMeeting(meeting.id, e)}
                          className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )

  // 根据视图状态渲染
  if (showHistory) {
    return renderHistoryView()
  }

  return showSummaryView ? renderSummaryView() : renderRecordingView()
}

