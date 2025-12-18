'use client'

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Copy, ScrollText, Edit3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { toast } from 'sonner'
import type { Transcript } from '@/types/meeting'

// 手动笔记类型
export interface ManualNote {
  id: string
  timestamp: string
  audio_start_time: number
  text: string
}

interface TranscriptViewProps {
  meetingId: string
  transcripts: Transcript[]
  manualNotes?: ManualNote[]
  onCopy?: () => void
  isTranscribing?: boolean
  isRecording?: boolean
  recordingTime?: number
  onManualNoteAdd?: (note: ManualNote) => void
}

export default function TranscriptView({ 
  meetingId, 
  transcripts, 
  manualNotes = [],
  onCopy, 
  isTranscribing = false,
  isRecording = false,
  recordingTime = 0,
  onManualNoteAdd
}: TranscriptViewProps) {
  const [currentNoteText, setCurrentNoteText] = useState('')
  const [currentNoteTimestamp, setCurrentNoteTimestamp] = useState<string | null>(null)
  const [currentNoteStartTime, setCurrentNoteStartTime] = useState<number>(0)
  const [isEditing, setIsEditing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)

  // 格式化时间戳
  const formatTimestamp = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`
  }

  // 将 user highlights 合并到对应的转录内容后面
  const mergedTranscripts = useMemo(() => {
    if (transcripts.length === 0) return []
    
    // 按时间排序转录
    const sortedTranscripts = [...transcripts].sort((a, b) => a.audio_start_time - b.audio_start_time)
    
    // 按时间排序笔记
    const sortedNotes = [...manualNotes].sort((a, b) => a.audio_start_time - b.audio_start_time)
    
    // 为每个转录项分配对应的 highlights
    const result = sortedTranscripts.map((transcript, index) => {
      const nextTranscript = sortedTranscripts[index + 1]
      
      // 找到属于这个转录项的 highlights
      // 规则：highlight 的时间戳 < 下一个转录的时间戳，就归到当前转录
      const highlights = sortedNotes.filter(note => {
        if (nextTranscript) {
          // 如果有下一个转录，highlight 时间必须 < 下一个转录的时间
          return note.audio_start_time < nextTranscript.audio_start_time && 
                 note.audio_start_time >= transcript.audio_start_time
        } else {
          // 如果是最后一个转录，所有剩余的 highlights 都归到这里
          return note.audio_start_time >= transcript.audio_start_time
        }
      })
      
      // 对于第一个转录之前的 highlights，也归到第一个转录
      if (index === 0) {
        const beforeFirstHighlights = sortedNotes.filter(note => 
          note.audio_start_time < transcript.audio_start_time
        )
        highlights.unshift(...beforeFirstHighlights)
      }
      
      return {
        ...transcript,
        highlights: highlights.map(h => h.text)
      }
    })
    
    return result
  }, [transcripts, manualNotes])

  const handleCopy = () => {
    // 复制合并后的内容
    const text = mergedTranscripts
      .map(t => {
        let line = `${t.timestamp} ${t.transcript}`
        if (t.highlights && t.highlights.length > 0) {
          line += `（${t.highlights.join('）（')}）`
        }
        return line
      })
      .join('\n')
    
    if (text) {
      navigator.clipboard.writeText(text)
      toast.success('Content copied to clipboard')
      onCopy?.()
    } else {
      toast.error('No content to copy')
    }
  }

  // 处理输入区域点击 - 开始新的笔记
  const handleInputFocus = useCallback(() => {
    if (!isRecording) return
    
    // 如果当前没有正在编辑的笔记，创建新的时间戳
    if (!isEditing || !currentNoteTimestamp) {
      const timestamp = formatTimestamp(recordingTime)
      setCurrentNoteTimestamp(timestamp)
      setCurrentNoteStartTime(recordingTime)
      setIsEditing(true)
    }
  }, [isRecording, recordingTime, isEditing, currentNoteTimestamp])

  // 处理文本输入
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setCurrentNoteText(e.target.value)
  }

  // 处理键盘事件 - Enter 键保存笔记
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      saveCurrentNote()
    }
  }

  // 保存当前笔记
  const saveCurrentNote = useCallback(() => {
    if (!currentNoteText.trim() || !currentNoteTimestamp) return
    
    const newNote: ManualNote = {
      id: `note-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: currentNoteTimestamp,
      audio_start_time: currentNoteStartTime,
      text: currentNoteText.trim()
    }
    
    onManualNoteAdd?.(newNote)
    
    // 重置输入状态
    setCurrentNoteText('')
    setCurrentNoteTimestamp(null)
    setIsEditing(false)
    
    // 滚动到底部
    setTimeout(() => {
      if (scrollAreaRef.current) {
        const scrollContainer = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]')
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight
        }
      }
    }, 100)
  }, [currentNoteText, currentNoteTimestamp, currentNoteStartTime, onManualNoteAdd])

  // 自动调整 textarea 高度
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
    }
  }, [currentNoteText])

  // 如果是录音状态，显示笔记记录界面
  if (isRecording) {
    return (
      <div className="flex flex-col h-full">
        {/* 工具栏 */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2">
            <Edit3 className="w-5 h-5 text-blue-600" />
            <h3 className="font-semibold text-gray-800">Notes</h3>
            <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full animate-pulse">
              Recording
            </span>
          </div>
          {manualNotes.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              className="h-8"
            >
              <Copy className="w-4 h-4 mr-2" />
              Copy
            </Button>
          )}
        </div>

        {/* 笔记内容区域 */}
        <div className="flex-1 overflow-hidden" ref={scrollAreaRef}>
          <ScrollArea className="h-full w-full">
            <div className="p-4">
              {manualNotes.length === 0 ? (
                <div className="flex flex-col items-center justify-center min-h-[200px] text-gray-400">
                  <Edit3 className="w-12 h-12 mb-4 opacity-50" />
                  <p className="text-sm">Click below to add notes</p>
                  <p className="text-xs mt-1">Timestamp will be added automatically</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {manualNotes
                    .sort((a, b) => a.audio_start_time - b.audio_start_time)
                    .map((note) => (
                      <div
                        key={note.id}
                        className="text-sm leading-relaxed text-blue-700 bg-blue-50 p-3 rounded-md border-l-2 border-blue-400"
                      >
                        <span className="font-mono text-blue-500 mr-2">
                          {note.timestamp}
                        </span>
                        <span>{note.text}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* 输入区域 */}
        <div className="border-t p-3 bg-gray-50">
          <div className="flex items-start gap-2">
            {/* 显示当前时间戳 */}
            <div className="flex-shrink-0 pt-2">
              {isEditing && currentNoteTimestamp ? (
                <span className="font-mono text-sm text-blue-600 bg-blue-100 px-2 py-1 rounded">
                  {currentNoteTimestamp}
                </span>
              ) : (
                <span className="font-mono text-sm text-gray-400 px-2 py-1">
                  {formatTimestamp(recordingTime)}
                </span>
              )}
            </div>
            
            {/* 输入框 */}
            <div className="flex-1">
              <textarea
                ref={textareaRef}
                value={currentNoteText}
                onChange={handleTextChange}
                onFocus={handleInputFocus}
                onKeyDown={handleKeyDown}
                placeholder="Click to add note, press Enter to save..."
                className="w-full px-3 py-2 text-sm border rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                rows={1}
                style={{ minHeight: '38px' }}
              />
            </div>
            
            {/* 保存按钮 */}
            {currentNoteText.trim() && (
              <Button
                size="sm"
                onClick={saveCurrentNote}
                className="flex-shrink-0 h-9"
              >
                Save
              </Button>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-2 ml-1">
            💡 Click to capture timestamp, press Enter to save
          </p>
        </div>
      </div>
    )
  }

  // 非录音状态：显示合并后的转录内容（转录 + 内联 highlights）
  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-2">
          <ScrollText className="w-5 h-5 text-gray-600" />
          <h3 className="font-semibold text-gray-800">Transcript</h3>
          {manualNotes.length > 0 && (
            <span className="text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
              {manualNotes.length} highlights
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="h-8"
          >
            <Copy className="w-4 h-4 mr-2" />
            Copy
          </Button>
        </div>
      </div>

      {/* 合并后的内容区域 */}
      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-4">
            {isTranscribing ? (
              <div className="flex flex-col items-center justify-center min-h-[400px] text-gray-500">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-500 mb-4"></div>
                <p className="text-lg font-medium">Transcribing...</p>
                <p className="text-sm mt-2 text-gray-400">Please wait, content will appear when ready</p>
              </div>
            ) : mergedTranscripts.length === 0 ? (
              <div className="flex flex-col items-center justify-center min-h-[400px] text-gray-400">
                <ScrollText className="w-16 h-16 mb-4 opacity-50" />
                <p className="text-lg">No transcripts yet</p>
                <p className="text-sm mt-2">Start recording to generate transcripts</p>
              </div>
            ) : (
              <div className="space-y-3">
                {mergedTranscripts.map((item) => (
                  <div
                    key={item.id}
                    className="text-sm text-gray-700 leading-relaxed"
                  >
                    <span className="font-mono text-gray-500 mr-2">
                      {item.timestamp}
                    </span>
                    <span>{item.transcript}</span>
                    {item.highlights && item.highlights.length > 0 && (
                      <span className="text-blue-600 font-medium">
                        （{item.highlights.join('）（')}）
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
