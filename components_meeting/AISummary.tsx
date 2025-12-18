'use client'

import React, { useState, useEffect, useRef } from 'react'
import { BlockNoteEditor, PartialBlock } from '@blocknote/core'
import { BlockNoteViewRaw, useCreateBlockNote } from '@blocknote/react'
import '@blocknote/core/style.css'
import { 
  Sparkles, 
  Copy, 
  Share2, 
  Mic,
  Bot,
  FileText,
  Languages
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import type { SummaryProcess } from '@/types/meeting'
import { TEMPLATE_OPTIONS } from '@/utils/meeting-templates'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// 支持的摘要语言选项（与项目支持的7种语言一致）
const SUMMARY_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文 (Chinese)' },
  { value: 'ja', label: '日本語 (Japanese)' },
  { value: 'ms', label: 'Bahasa Melayu (Malay)' },
  { value: 'id', label: 'Bahasa Indonesia (Indonesian)' },
  { value: 'th', label: 'ไทย (Thai)' },
  { value: 'vi', label: 'Tiếng Việt (Vietnamese)' },
] as const

type SummaryLanguage = typeof SUMMARY_LANGUAGES[number]['value']

interface AISummaryProps {
  meetingId: string
  summary: SummaryProcess | null
  onGenerate: (templateId?: string, contextPrompt?: string, language?: string) => Promise<void>
  onSave: (content: string) => Promise<void>
  isRecording?: boolean
  defaultLanguage?: string // 默认语言（用于自动生成时）
}

export default function AISummary({ 
  meetingId, 
  summary, 
  onGenerate, 
  onSave,
  isRecording = false,
  defaultLanguage = 'en'
}: AISummaryProps) {
  const [contextPrompt, setContextPrompt] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState<string>('default')
  const [selectedLanguage, setSelectedLanguage] = useState<SummaryLanguage>(defaultLanguage as SummaryLanguage)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  // 本地状态：存储当前显示的摘要（可能来自不同模板）
  const [currentSummary, setCurrentSummary] = useState<SummaryProcess | null>(summary)
  // 跟踪最后加载的内容，避免重复加载相同内容
  const lastLoadedContentRef = useRef<string | null>(null)
  // 跟踪用户是否正在编辑
  const isUserEditingRef = useRef(false)

  // 初始化 BlockNote 编辑器
  // 创建一个默认的空段落块，确保文档始终至少有一个块
  const editor: BlockNoteEditor | null = useCreateBlockNote(
    {
      initialContent: [
        {
          type: 'paragraph',
          content: []
        }
      ],
    },
    [] // 空依赖项，编辑器只初始化一次
  )

  // 监听编辑器变化，标记用户正在编辑
  useEffect(() => {
    if (!editor) return

    let editingTimeout: NodeJS.Timeout | null = null

    const handleChange = () => {
      isUserEditingRef.current = true
      // 清除之前的定时器
      if (editingTimeout) {
        clearTimeout(editingTimeout)
      }
      // 5秒后重置编辑状态（假设用户停止编辑）
      editingTimeout = setTimeout(() => {
        isUserEditingRef.current = false
      }, 5000)
    }

    // BlockNote 的 onChange 返回一个取消函数
    const unsubscribe = editor.onChange(handleChange)

    return () => {
      if (editingTimeout) {
        clearTimeout(editingTimeout)
      }
      if (unsubscribe) {
        unsubscribe()
      }
    }
  }, [editor])

  // 同步父组件传入的摘要到本地状态
  useEffect(() => {
    if (summary) {
      // 如果父组件传入的摘要属于其他模板（例如后台轮询更新了 standard，
      // 而当前正在查看 daily_standup），则忽略这次更新，避免“串台”。
      if (summary.template_id && summary.template_id !== selectedTemplate) {
        console.log(
          'ℹ️ Ignoring summary update for template',
          summary.template_id,
          'because current selectedTemplate is',
          selectedTemplate
        )
        return
      }

      // 注意：后端在 GET /summary?template_id=xxx 时已经按模板拆分，
      // summary.template_id 存在时，result 应该是该模板的纯文本 Markdown。
      let processedSummary: SummaryProcess | null = summary

      // 仅在非常旧的数据中（template_id 为空且 result 是一个按模板划分的大 JSON）做一次兼容处理，
      // 且严格按当前 selectedTemplate 提取；如果没有对应模板，则视为该模板暂无摘要。
      if (summary.result && !summary.template_id) {
        try {
          const parsed = JSON.parse(summary.result)
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            const targetTemplateId = selectedTemplate || 'default'
            const templateResult = parsed[targetTemplateId]
            if (templateResult) {
              processedSummary = {
                ...summary,
                result: templateResult,
                template_id: targetTemplateId,
              }
              console.log('📋 Extracted legacy summary for template:', targetTemplateId)
            } else {
              // 该模板没有历史摘要，当前视图应为空
              processedSummary = null
              console.log('ℹ️ No legacy summary for template:', targetTemplateId)
            }
          }
        } catch {
          // 解析失败，说明是旧格式（纯文本），直接使用
          console.log('📋 Result is plain text, using directly')
        }
      } else if (summary.template_id) {
        console.log('📋 Using summary for template from API:', summary.template_id)
      }

      setCurrentSummary(processedSummary)

      // 不再从 summary 反向覆盖 selectedTemplate，模板选择完全由用户操作控制，
      // 避免不同模板之间的显示"串台"。
      if (processedSummary?.context_prompt) {
        setContextPrompt(processedSummary.context_prompt)
      }
    } else {
      // 如果 summary 为 null，只清空 currentSummary，但不要重置 selectedTemplate
      // 因为 summary 为 null 可能是：
      // 1. 轮询时后端还在生成中（临时状态）
      // 2. 该模板确实没有摘要（但用户可能正在查看其他模板）
      // 重置 selectedTemplate 会导致用户正在查看的模板被切换，造成困扰
      setCurrentSummary(null)
      // 不再重置 selectedTemplate，保持用户当前的选择
      // setSelectedTemplate('default') // 移除这行
      // setContextPrompt('') // 也不重置 contextPrompt，保持用户输入
    }
  }, [summary, selectedTemplate]) // 添加 selectedTemplate 依赖，确保过滤逻辑正确

  // 当选择的模板变化时，加载对应模板的摘要（语言切换已在 onValueChange 中处理）
  const prevTemplateRef = useRef<string | null>(null)
  const isInitialMountRef = useRef(true) // 跟踪是否是首次挂载
  
  useEffect(() => {
    const loadTemplateSummary = async () => {
      try {
        console.log('🔄 Loading summary for template:', selectedTemplate, 'language:', selectedLanguage)
        const response = await fetch(`/api/meetings/${meetingId}/summary?template_id=${selectedTemplate}&language=${selectedLanguage}`)
        if (response.ok) {
          const { summary: s } = await response.json()
          if (s && s.result) {
            // 更新本地显示的摘要
            setCurrentSummary(s)
            // 模板切换后强制认为是新内容，允许重新渲染到编辑器
            lastLoadedContentRef.current = null
            // 重置编辑状态，确保新模板的内容可以加载到编辑器
            isUserEditingRef.current = false
            console.log('✅ Loaded summary for template:', selectedTemplate, 'language:', selectedLanguage, 'has result:', !!s.result)
          } else {
            // 如果该模板还没有摘要，清空显示
            setCurrentSummary(null)
            lastLoadedContentRef.current = null
            console.log('ℹ️ No summary found for template:', selectedTemplate, 'language:', selectedLanguage)

            // 该模板还没有摘要时，自动触发一次生成（但 default 模板不应该自动生成，因为已经在停止录制时生成过了）
            if (!isGenerating && meetingId && selectedTemplate !== 'default') {
              try {
                console.log('✨ Auto-generating summary for template:', selectedTemplate)
                // 直接调用父组件传入的 onGenerate，使用当前模板和上下文
                // 这里不弹 toast，由 AISummary 的状态和后端轮询来更新界面
                await onGenerate(selectedTemplate, contextPrompt || undefined, selectedLanguage)
              } catch (e) {
                console.error('Auto-generate summary failed:', e)
              }
            }
          }
        }
      } catch (error) {
        console.error('Error loading template summary:', error)
      }
    }

    // 检查模板是否变化
    const templateChanged = prevTemplateRef.current !== null && prevTemplateRef.current !== selectedTemplate
    
    // 如果是首次挂载，且父组件没有传入 summary，或者传入的 summary 不属于当前模板，则加载
    // 如果是模板切换（非首次），则加载
    if (meetingId) {
      if (isInitialMountRef.current) {
        // 首次挂载：如果父组件传入的 summary 不属于当前模板，或者没有传入 summary，则加载
        if (!summary || (summary.template_id && summary.template_id !== selectedTemplate)) {
          console.log('🔄 Initial mount: loading summary for template:', selectedTemplate, 'because summary template_id is', summary?.template_id)
          loadTemplateSummary()
        } else {
          console.log('ℹ️ Initial mount: using provided summary for template:', summary.template_id)
        }
        isInitialMountRef.current = false
      } else if (templateChanged) {
        // 模板切换：加载新模板的摘要
        console.log('🔄 Template changed from', prevTemplateRef.current, 'to', selectedTemplate, '- loading summary')
        loadTemplateSummary()
      }
    }
    
    prevTemplateRef.current = selectedTemplate
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplate, meetingId, isGenerating, contextPrompt, onGenerate])

  // 当摘要更新时，使用 BlockNote 内置的 Markdown 解析
  useEffect(() => {
    if (currentSummary?.result && editor) {
      const loadMarkdown = async () => {
        let markdownText = currentSummary.result
        if (!markdownText) return

        // 如果内容没有变化，不重新加载
        if (lastLoadedContentRef.current === markdownText) {
          return
        }

        // 如果用户正在编辑，不自动替换内容
        if (isUserEditingRef.current) {
          console.log('⏸️ User is editing, skipping auto-update')
          return
        }
        
        // 如果 result 看起来是 JSON（历史上有部分模板曾返回 JSON），
        // 尝试转换为更易读的 Markdown 再渲染，避免在编辑器里直接看到原始 JSON。
        const trimmed = markdownText.trim()
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            const json = JSON.parse(trimmed)
            const jsonToMarkdown = (value: any, level: number = 2): string => {
              if (value == null) return ''
              if (typeof value === 'string') return value
              if (Array.isArray(value)) {
                return value
                  .map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item, null, 2)}`)
                  .join('\n')
              }
              if (typeof value === 'object') {
                const lines: string[] = []
                for (const [key, val] of Object.entries(value)) {
                  lines.push(`${'#'.repeat(level)} ${key}`)
                  lines.push('')
                  lines.push(jsonToMarkdown(val, Math.min(level + 1, 6)))
                  lines.push('')
                }
                return lines.join('\n')
              }
              return String(value)
            }
            markdownText = jsonToMarkdown(json)
            console.log('🔄 Converted JSON summary to Markdown for rendering')
          } catch {
            // 如果解析失败，继续按普通 Markdown 处理
          }
        }

        try {
          // 预处理 Markdown：修复可能导致解析错误的问题
          let processedMarkdown = markdownText
          
          // BlockNote 在解析有序列表时，如果列表不是从 1 开始，可能会有问题
          // 预处理：将所有有序列表重置为从 1 开始
          const lines = processedMarkdown.split('\n')
          let listCounter = 0
          let inList = false
          
          processedMarkdown = lines.map((line, index) => {
            const trimmed = line.trim()
            const numberedListMatch = trimmed.match(/^(\d+)\.\s+(.+)$/)
            
            if (numberedListMatch) {
              const prevLine = index > 0 ? lines[index - 1].trim() : ''
              const isPrevLineList = /^\d+\.\s+/.test(prevLine)
              
              if (!isPrevLineList) {
                // 新列表开始，重置计数器
                listCounter = 1
                inList = true
              } else {
                // 继续当前列表
                listCounter++
              }
              
              // 返回从 1 开始的有序列表
              const indent = line.match(/^(\s*)/)?.[1] || ''
              return `${indent}${listCounter}. ${numberedListMatch[2]}`
            } else {
              // 不是有序列表项，重置状态
              if (trimmed === '' || /^[#\-*]/.test(trimmed)) {
                inList = false
                listCounter = 0
              }
              return line
            }
          }).join('\n')
          
          // 直接使用 BlockNote 的内置解析器，它会自动识别表格
          let blocks
          try {
            blocks = await editor.tryParseMarkdownToBlocks(processedMarkdown)
          } catch (parseError: any) {
            console.warn('⚠️ Parse failed:', parseError?.message)
            console.log('🔧 Attempting to fix by converting numbered lists to bullet lists...')
            
            // 如果解析失败，将有序列表转换为无序列表
            let fixedMarkdown = processedMarkdown.replace(/^\d+\.\s+/gm, '- ')
            
            try {
              blocks = await editor.tryParseMarkdownToBlocks(fixedMarkdown)
              console.log('✅ Parse succeeded after converting numbered lists to bullet lists')
            } catch (secondError: any) {
              console.error('❌ Second parse attempt also failed:', secondError?.message)
              throw parseError // 抛出原始错误
            }
          }
          
          console.log('📦 Parsed blocks count:', blocks?.length)
          console.log('📦 Block types:', blocks?.map(b => b.type))
          
          if (blocks && blocks.length > 0) {
            // 验证 blocks 是否有效
            const validBlocks = blocks.filter((block, index) => {
              // 检查块是否有必需的属性
              if (!block.type) {
                console.warn('⚠️ Block missing type at index', index, ':', block)
                return false
              }
              return true
            })
            
            // 对于有序列表，创建新的 block 对象以确保有正确的属性
            const fixedBlocks = validBlocks.map((block) => {
              // 如果是有序列表且缺少 start 属性，创建一个新的 block
              if (block.type === 'numberedListItem') {
                const startValue = (block.props as any)?.start ?? 1
                return {
                  ...block,
                  props: {
                    ...block.props,
                    start: startValue
                  } as any
                }
              }
              return block
            })
            
            if (fixedBlocks.length > 0) {
              // 获取当前所有块的 ID
              const currentBlocks = editor.document
              const currentBlockIds = currentBlocks.map(block => block.id)
              
              // 直接替换所有现有块
              if (currentBlockIds.length > 0) {
                try {
                  // 尝试替换所有块
                  editor.replaceBlocks(currentBlockIds, fixedBlocks)
                } catch (replaceError: any) {
                  console.error('❌ replaceBlocks failed:', replaceError)
                  console.error('Error details:', replaceError?.message)
                  
                  // 如果替换失败，尝试逐个替换
                  try {
                    // 先删除所有现有块
                    editor.removeBlocks(currentBlockIds)
                    // 等待删除完成
                    setTimeout(() => {
                      // 然后插入新块
                      if (editor.document.length === 0) {
                        // 如果文档为空，创建一个临时块
                        const tempBlock: PartialBlock = {
                          type: 'paragraph',
                          content: []
                        }
                        editor.insertBlocks([tempBlock], undefined as any, 'after')
                        // 等待插入完成后再替换
                        setTimeout(() => {
                          if (editor.document.length > 0) {
                            editor.replaceBlocks([editor.document[0].id], fixedBlocks)
                          }
                        }, 10)
                      } else {
                        // 如果还有块，直接替换第一个
                        editor.replaceBlocks([editor.document[0].id], fixedBlocks)
                      }
                    }, 10)
                  } catch (fallbackError) {
                    console.error('❌ Fallback replace also failed:', fallbackError)
                  }
                }
              } else {
                // 如果文档为空，先插入一个临时块，然后替换
                const tempBlock: PartialBlock = {
                  type: 'paragraph',
                  content: []
                }
                try {
                  editor.insertBlocks([tempBlock], undefined as any, 'after')
                  // 等待插入完成
                  setTimeout(() => {
                    if (editor.document.length > 0) {
                      editor.replaceBlocks([editor.document[0].id], fixedBlocks)
                    }
                  }, 10)
                } catch (insertError) {
                  console.error('❌ Failed to insert temp block:', insertError)
                }
              }
            } else {
              console.error('❌ No valid blocks after filtering')
            }
            
            // 标记内容已加载
            lastLoadedContentRef.current = markdownText
          }
        } catch (error: any) {
          console.error('❌ Failed to parse markdown:', error)
          console.error('Error message:', error?.message)
          console.error('Error stack:', error?.stack)
          console.error('Markdown content (first 500 chars):', markdownText.substring(0, 500))
          
          // 如果解析失败，尝试使用简单的文本块显示内容
          try {
            const errorBlock: PartialBlock = {
              type: 'paragraph',
              content: [{
                type: 'text',
                text: markdownText.substring(0, 1000) + (markdownText.length > 1000 ? '...' : ''),
                styles: {}
              }]
            }
            const currentBlockIds = editor.document.map(block => block.id)
            if (currentBlockIds.length > 0) {
              editor.replaceBlocks(currentBlockIds, [errorBlock])
            }
            // 即使出错也标记为已加载，避免重复尝试
            lastLoadedContentRef.current = markdownText
          } catch (fallbackError) {
            console.error('❌ Fallback error display also failed:', fallbackError)
          }
        }
      }
      loadMarkdown()
    } else if (!currentSummary?.result && editor) {
      // 如果没有摘要内容，清空编辑器（保留一个空段落）
      const currentBlocks = editor.document
      if (currentBlocks.length > 1) {
        // 如果有多个块，只保留第一个
        const blockIds = currentBlocks.slice(1).map(block => block.id)
        editor.removeBlocks(blockIds)
      }
      // 清空第一个块的内容
      if (currentBlocks.length > 0) {
        const firstBlock = currentBlocks[0]
        editor.updateBlock(firstBlock, {
          type: 'paragraph',
          content: []
        })
      }
    }
  }, [currentSummary?.result, editor])

  const handleSave = async () => {
    if (!editor) return
    setIsSaving(true)
    try {
      const markdown = await editor.blocksToMarkdownLossy(editor.document)
      // 保存时传入当前模板 ID
      const response = await fetch(`/api/meetings/${meetingId}/summary`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          result: markdown,
          template_id: selectedTemplate
        })
      })
      
      if (!response.ok) throw new Error('Failed to save summary')
      
      const { summary: updatedSummary } = await response.json()
      setCurrentSummary(updatedSummary)
      toast.success('Summary saved')
    } catch (error: any) {
      toast.error(error.message || 'Failed to save summary')
    } finally {
      setIsSaving(false)
    }
  }

  const handleCopy = async () => {
    if (!editor) return
    try {
      const markdown = await editor.blocksToMarkdownLossy(editor.document)
      await navigator.clipboard.writeText(markdown)
      toast.success('Summary copied to clipboard')
    } catch (error) {
      toast.error('Failed to copy summary')
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="p-3 border-b space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-gray-600" />
            <h3 className="font-semibold text-gray-800">AI Summary</h3>
          </div>
          <div className="flex items-center gap-2">
            {/* 语言选择下拉框 */}
            <Select
              value={selectedLanguage}
              onValueChange={async (value) => {
                const newLanguage = value as SummaryLanguage
                setSelectedLanguage(newLanguage)
                // 切换语言时重置编辑状态，允许重新生成
                isUserEditingRef.current = false
                
                // 立即尝试加载该语言的摘要（类似 LanguageSwitcher 的即时切换）
                if (selectedTemplate && meetingId) {
                  try {
                    console.log(`🔄 Language changed to ${newLanguage}, loading summary for template: ${selectedTemplate}`)
                    
                    // 先尝试 GET API，检查是否已有翻译（快速响应）
                    const response = await fetch(`/api/meetings/${meetingId}/summary?template_id=${selectedTemplate}&language=${newLanguage}`)
                    
                    let shouldTranslate = true // 是否需要翻译
                    
                    if (response.ok) {
                      const { summary: s } = await response.json()
                      if (s && s.result) {
                        // 检查返回的摘要是否是真正的翻译版本
                        // 如果请求的是英文，直接使用
                        if (newLanguage === 'en') {
                          setCurrentSummary(s)
                          lastLoadedContentRef.current = null
                          isUserEditingRef.current = false
                          console.log(`✅ Loaded English summary`)
                          return
                        }
                        
                        // 对于非英文语言，需要检查是否真的是翻译版本
                        // 由于后端会回退到英文版本，我们需要通过检查内容来判断
                        // 先尝试加载英文版本，比较内容是否相同
                        try {
                          const enCheckResponse = await fetch(`/api/meetings/${meetingId}/summary?template_id=${selectedTemplate}&language=en`)
                          if (enCheckResponse.ok) {
                            const { summary: enCheck } = await enCheckResponse.json()
                            if (enCheck?.result) {
                              if (enCheck.result === s.result) {
                                // 内容相同，说明返回的是英文版本（后端回退），需要翻译
                                console.log(`⚠️ Backend returned English version (fallback), need to translate to ${newLanguage}`)
                                shouldTranslate = true
                                // 不返回，继续执行翻译逻辑
                              } else {
                                // 内容不同，说明是真正的翻译版本
                                setCurrentSummary(s)
                                lastLoadedContentRef.current = null
                                isUserEditingRef.current = false
                                console.log(`✅ Loaded existing translation for ${newLanguage}`)
                                return // 已有翻译，直接返回，不进行翻译
                              }
                            } else {
                              // 英文版本不存在，但返回了结果，假设是翻译版本
                              setCurrentSummary(s)
                              lastLoadedContentRef.current = null
                              isUserEditingRef.current = false
                              console.log(`✅ Loaded summary for ${newLanguage}`)
                              return
                            }
                          } else {
                            // 无法检查英文版本，假设返回的是翻译版本
                            setCurrentSummary(s)
                            lastLoadedContentRef.current = null
                            isUserEditingRef.current = false
                            console.log(`✅ Loaded summary for ${newLanguage} (could not verify)`)
                            return
                          }
                        } catch (checkError) {
                          // 检查失败，假设返回的是翻译版本
                          console.warn('Failed to verify translation:', checkError)
                          setCurrentSummary(s)
                          lastLoadedContentRef.current = null
                          isUserEditingRef.current = false
                          console.log(`✅ Loaded summary for ${newLanguage} (verification failed)`)
                          return
                        }
                      }
                    }
                    
                    // 如果没有找到翻译，或者返回的是英文版本
                    if (shouldTranslate) {
                      console.log(`⚠️ Translation not found for language: ${newLanguage}, will translate`)
                    }
                    
                    // 如果切换到英文但找不到，清空显示
                    if (newLanguage === 'en') {
                      setCurrentSummary(null)
                      lastLoadedContentRef.current = null
                      return
                    }
                    
                    // 对于其他语言，需要翻译。先确保有英文版本可用
                    // 先尝试加载英文版本（translate_only API 需要英文版本作为基础）
                    console.log(`🔄 Loading English version for translation...`)
                    const enResponse = await fetch(`/api/meetings/${meetingId}/summary?template_id=${selectedTemplate}&language=en`)
                    
                    if (enResponse.ok) {
                      const { summary: enSummary } = await enResponse.json()
                      if (enSummary?.result) {
                        // 临时显示英文版本，让用户知道正在翻译
                        setCurrentSummary(enSummary)
                        
                        // 触发翻译
                        console.log(`🌐 Translating summary to ${newLanguage}...`)
                        
                        // 异步翻译，不阻塞 UI
                        fetch(`/api/meetings/${meetingId}/summary`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            template_id: selectedTemplate,
                            language: newLanguage,
                            translate_only: true,
                          }),
                        })
                          .then(async (res) => {
                            if (res.ok) {
                              const { summary } = await res.json()
                              if (summary) {
                                // 更新本地状态
                                setCurrentSummary(summary)
                                lastLoadedContentRef.current = null
                                isUserEditingRef.current = false
                                console.log(`✅ Translation completed for ${newLanguage}`)
                              }
                            } else {
                              const error = await res.json()
                              console.error('Translation failed:', error)
                              toast.error(`Translation failed: ${error.error || 'Unknown error'}`)
                            }
                          })
                          .catch(e => {
                            console.error('Failed to translate summary with new language:', e)
                            toast.error('Translation failed. Please try again.')
                          })
                      } else {
                        console.error(`❌ No English summary found to translate to ${newLanguage}`)
                        toast.error('No English summary available for translation')
                      }
                    } else {
                      console.error(`❌ Failed to load English summary for translation`)
                      toast.error('Failed to load English summary for translation')
                    }
                  } catch (error) {
                    console.error('Error loading summary for new language:', error)
                  }
                }
              }}
            >
              <SelectTrigger className="h-8 w-[180px] text-xs">
                <SelectValue>
                  <div className="flex items-center gap-1">
                    <Languages className="w-3 h-3" />
                    <span>{SUMMARY_LANGUAGES.find(l => l.value === selectedLanguage)?.label || 'English'}</span>
                  </div>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SUMMARY_LANGUAGES.map(lang => (
                  <SelectItem key={lang.value} value={lang.value}>
                    {lang.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* 模板选择下拉框 */}
            <Select
              value={selectedTemplate}
              onValueChange={(value) => {
                // 切换模板时：
                // 1. 更新当前选择
                // 2. 重置已加载内容标记，确保新模板内容会写入编辑器
                // 3. 重置编辑状态，允许新模板的内容加载到编辑器
                setSelectedTemplate(value)
                lastLoadedContentRef.current = null
                isUserEditingRef.current = false // 切换模板时重置编辑状态，允许加载新内容
              }}
            >
              <SelectTrigger className="h-8 w-[200px] text-xs">
                <SelectValue placeholder="Select template" />
              </SelectTrigger>
              <SelectContent>
                {TEMPLATE_OPTIONS.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSave}
              disabled={isSaving}
              className="h-8"
            >
              <Share2 className="w-4 h-4 mr-2" />
              Share
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              className="h-8"
            >
              <Copy className="w-4 h-4 mr-2" />
              Copy
            </Button>
            {isRecording && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-red-600"
              >
                <Mic className="w-4 h-4 mr-2" />
                Recording
              </Button>
            )}
          </div>
        </div>

        {/* 上下文输入框 */}
        <div>
          <Label className="text-xs text-gray-600 mb-1 block">
            Add context for AI summary
          </Label>
          <Input
            value={contextPrompt}
            onChange={(e) => setContextPrompt(e.target.value)}
            placeholder="Enter additional context or instructions..."
            className="h-8 text-xs"
          />
        </div>
      </div>

      {/* 编辑器区域 */}
      <div className="flex-1 overflow-auto p-4 ai-summary-editor">
        {currentSummary?.status === 'processing' ? (
          <div className="flex flex-col items-center justify-center h-full">
            <Bot className="w-16 h-16 mb-4 text-gray-400 animate-pulse" />
            <p className="text-lg text-gray-600">Generating summary...</p>
          </div>
        ) : currentSummary?.status === 'failed' ? (
          <div className="flex flex-col items-center justify-center h-full text-red-500">
            <FileText className="w-16 h-16 mb-4" />
            <p className="text-lg">Failed to generate summary</p>
            <p className="text-sm mt-2">{currentSummary.error_message}</p>
          </div>
        ) : editor ? (
          <BlockNoteViewRaw 
            editor={editor} 
            theme="light"
            editable={true}
            formattingToolbar={false}
            sideMenu={false}
            filePanel={false}
            tableHandles={false}
            comments={false}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <FileText className="w-16 h-16 mb-4 opacity-50" />
            <p className="text-lg">Loading editor...</p>
          </div>
        )}
      </div>

      {/* 状态栏 */}
      {currentSummary?.status === 'completed' && (
        <div className="p-2 bg-green-50 border-t">
          <p className="text-xs text-green-700">Summary completed</p>
        </div>
      )}

    </div>
  )
}


    