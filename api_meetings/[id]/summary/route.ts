import { NextRequest, NextResponse } from 'next/server'
import { createClients } from '@/utils/supabase/server'
import { AIService } from '@/lib/ai-service'
import { generateMeetingSummary } from '@/lib/agent-framework/agents/meeting-summary-agent'
import { generateSystemPromptFromTemplate } from '@/utils/meeting-templates'
import { loadTemplateServer } from '@/utils/meeting-templates-server'
import { PROMPTS } from '@/lib/prompts'

const translateText = async (text: string, targetLanguage: string): Promise<string> => {
  try {
    const prompt = PROMPTS.translation.translateMarkdown(text, targetLanguage)
    
    console.log(`🌐 Translating text to ${targetLanguage}:`, text.substring(0, 100) + '...')
    
    // 直接调用AIService（服务端优化）
    const result = await AIService.chatCompletion(
      {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000,
      },
      {
        provider: 'llm',
        chargeCredits: false, // 翻译不扣费
      }
    )
    
    const translatedText = result.content
    
    if (translatedText === text) {
      console.warn('⚠️ Translation returned the same text, might have failed')
    }
    
    return translatedText
  } catch (error) {
    console.error('❌ Translation error:', error)
    return text // Return original text if translation fails
  }
}

// GET /api/meetings/[id]/summary - 获取摘要
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { supabaseServiceRole } = await createClients()
    
    // 获取 template_id 查询参数
    const { searchParams } = new URL(request.url)
    const templateId = searchParams.get('template_id') || undefined
    
    const { data, error } = await supabaseServiceRole
      .from('summary_processes')
      .select('*')
      .eq('meeting_id', id)
      .single()
    
    if (error && error.code !== 'PGRST116') { // PGRST116 = not found
      console.error('Error fetching summary:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    if (!data) {
      return NextResponse.json({ summary: null })
    }
    
    // 如果指定了 template_id，尝试从 JSON 中提取对应模板的摘要
    if (templateId && data.result) {
      try {
        const resultsByTemplate = JSON.parse(data.result)
        if (typeof resultsByTemplate === 'object' && resultsByTemplate !== null) {
          // 获取请求的语言（从 URL 参数或默认英文）
          const { searchParams } = new URL(request.url)
          const requestedLanguage = searchParams.get('language') || 'en'
          
          // 优先查找带语言后缀的版本（template_id_language），如果没有则使用基础版本（英文）
          // 英文版本存储在 templateId 键下，其他语言版本存储在 templateId_language 键下
          let templateResult: string | undefined = undefined
          
          if (requestedLanguage === 'en') {
            // 请求英文版本：只查找请求的模板，不要回退到其他模板
            // 这样当模板切换时，前端会检测到没有摘要并触发重新生成
            templateResult = resultsByTemplate[templateId]
            if (templateResult) {
              console.log(`✅ Found English version for template: ${templateId}`)
            } else {
              console.log(`⚠️ English version not found for template: ${templateId}`)
              console.log(`   Available keys:`, Object.keys(resultsByTemplate))
            }
          } else {
            // 请求其他语言：先查找翻译版本（templateId_language），如果没有则使用英文版本
            const languageKey = `${templateId}_${requestedLanguage}`
            if (resultsByTemplate[languageKey]) {
              templateResult = resultsByTemplate[languageKey]
              console.log(`✅ Found translated version: ${languageKey} for language: ${requestedLanguage}`)
            } else if (resultsByTemplate[templateId]) {
              // 如果没有翻译版本，使用英文版本
              templateResult = resultsByTemplate[templateId]
              console.log(`⚠️ Translated version not found, using English version: ${templateId} (requested language: ${requestedLanguage})`)
            } else {
              console.log(`⚠️ Neither translated nor English version found for template: ${templateId}`)
              console.log(`   Available keys:`, Object.keys(resultsByTemplate))
            }
          }
          
          if (templateResult) {
            // 该模板有对应的摘要，返回它
            return NextResponse.json({
              summary: {
                ...data,
                result: templateResult,
                template_id: templateId
              }
            })
          } else {
            // 该模板在 JSON 中不存在，返回 null（表示该模板还没有生成过摘要）
            console.log(`ℹ️ Template '${templateId}' (language: ${requestedLanguage}) not found in resultsByTemplate, returning null`)
            console.log(`   Available keys:`, Object.keys(resultsByTemplate))
            return NextResponse.json({ summary: null })
          }
        }
      } catch (e) {
        // 如果解析失败，说明 result 是旧格式（纯文本）
        // 检查当前记录的 template_id 是否匹配请求的 template_id
        if (data.template_id === templateId) {
          // 如果匹配，返回原始数据（旧格式，但属于该模板）
          return NextResponse.json({ summary: data })
        } else {
          // 如果不匹配，说明该模板还没有生成过，返回 null
          console.log(`ℹ️ Template '${templateId}' doesn't match current template_id '${data.template_id}', returning null`)
          return NextResponse.json({ summary: null })
        }
      }
    }
    
    // 如果没有指定 template_id，返回原始数据（用于兼容旧代码）
    return NextResponse.json({ summary: data })
  } catch (error: any) {
    console.error('Error in GET /api/meetings/[id]/summary:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// POST /api/meetings/[id]/summary - 生成摘要
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { supabaseServiceRole } = await createClients()
    const body = await request.json()
    
    const {
      template_id = 'default',
      context_prompt,
      language = 'en', // 摘要输出语言：en, zh, ja, ms, id, th, vi（但实际生成时总是用英文）
      use_template, // 可选：是否使用自定义模板 system prompt；false 时使用 DeepSeek 默认提示词
      translate_only = false, // 如果为 true，只翻译已有的英文摘要，不重新生成
    } = body
    
    console.log('📋 POST /summary received:', {
      template_id,
      language,
      use_template,
      translate_only,
      has_context_prompt: !!context_prompt
    })
    
    // 重要：无论请求什么语言，生成时总是用英文（节省成本），然后翻译
    // language 参数只用于决定是否需要翻译，以及翻译的目标语言
    
    // 如果 template_id 是 'default'，强制不使用模板；否则根据 use_template 参数决定
    const useTemplate = template_id === 'default' ? false : (use_template !== false)
    
    // 如果只是翻译请求（translate_only=true），且语言不是英文，尝试翻译已有的英文摘要
    if (translate_only && language !== 'en') {
      console.log(`🌐 Translation-only request for language: ${language}, template: ${template_id}`)
      const { data: existingSummary } = await supabaseServiceRole
        .from('summary_processes')
        .select('result')
        .eq('meeting_id', id)
        .single()
      
      if (existingSummary?.result) {
        try {
          const resultsByTemplate = JSON.parse(existingSummary.result)
          // 优先查找基础版本（template_id），如果没有则查找 default 或 standard
          const englishSummary = resultsByTemplate[template_id] || resultsByTemplate['default'] || resultsByTemplate['standard']
          
          if (englishSummary) {
            console.log(`🌐 Found English summary, translating to ${language}...`)
            const translatedSummary = await translateText(englishSummary, language)
            
            // 保存翻译后的摘要
            resultsByTemplate[`${template_id}_${language}`] = translatedSummary
            
            await supabaseServiceRole
              .from('summary_processes')
              .update({
                result: JSON.stringify(resultsByTemplate),
                status: 'completed'
              })
              .eq('meeting_id', id)
            
            console.log(`✅ Translation completed and saved for ${template_id}_${language}`)
            return NextResponse.json({
              summary: {
                result: translatedSummary,
                template_id: template_id,
                status: 'completed'
              }
            })
          } else {
            console.log(`⚠️ No English summary found for template: ${template_id}`)
          }
        } catch (e) {
          console.error('❌ Failed to translate existing summary:', e)
        }
      } else {
        console.log('⚠️ No existing summary found in database')
      }
      
      // 如果没有找到英文摘要，返回错误
      return NextResponse.json({ 
        error: 'No English summary found to translate',
        summary: null 
      }, { status: 404 })
    }
    
    console.log('📋 Generating summary with template_id:', template_id)
    
    // 获取所有转录文本
    const { data: transcripts, error: transcriptsError } = await supabaseServiceRole
      .from('transcripts')
      .select('*')
      .eq('meeting_id', id)
      .order('audio_start_time', { ascending: true })
    
    if (transcriptsError) {
      return NextResponse.json({ error: transcriptsError.message }, { status: 500 })
    }
    
    if (!transcripts || transcripts.length === 0) {
      return NextResponse.json({ error: 'No transcripts found for this meeting' }, { status: 400 })
    }
    
    // 组合转录文本
    const fullTranscript = transcripts
      .map(t => `${t.timestamp} ${t.transcript}`)
      .join('\n')
    
    // 创建或更新摘要记录
    const { data: existingSummary } = await supabaseServiceRole
      .from('summary_processes')
      .select('*')
      .eq('meeting_id', id)
      .single()
    
    // 加载模板（在创建/更新记录之前，以便使用正确的 template_id）
    let template = null
    let actualTemplateId = template_id
    
    if (useTemplate && template_id !== 'default') {
      try {
        template = await loadTemplateServer(template_id)
        console.log('✅ Loaded template:', template_id, 'name:', template?.name)
      } catch (error: any) {
        console.error('❌ Failed to load template:', template_id, error)
        // 如果模板加载失败，回退到 default（不使用模板）
        actualTemplateId = 'default'
        template = null
        console.log('✅ Fallback to default (no template)')
      }
    } else {
      // default 模式：不使用任何自定义模板，完全依赖 DeepSeek 默认提示词
      template = null
      actualTemplateId = 'default'
      console.log('ℹ️ Using DeepSeek default prompt (no custom template system prompt)')
    }

    // 创建或更新摘要记录（使用实际加载的模板 ID）
    if (existingSummary) {
      // 更新状态为 processing
      await supabaseServiceRole
        .from('summary_processes')
        .update({ 
          status: 'processing',
          template_id: actualTemplateId,
          context_prompt
        })
        .eq('meeting_id', id)
    } else {
      // 创建新记录
      await supabaseServiceRole
        .from('summary_processes')
        .insert({
          meeting_id: id,
          status: 'processing',
          llm_provider: 'deepseek',
          llm_model: 'deepseek-chat',
          template_id: actualTemplateId,
          context_prompt
        })
    }

    // 生成 system prompt（仅在启用模板时）
    // 如果使用模板，总是用英文生成（节省成本），然后翻译
    let systemPrompt: string | undefined = undefined
    if (useTemplate && template) {
      systemPrompt = generateSystemPromptFromTemplate(template, context_prompt, 'en') // 总是用英文生成模板
    }

    // 异步生成摘要（不阻塞响应）
    // 保存实际使用的 template_id 到闭包中
    const finalTemplateId = actualTemplateId
    const requestedLanguage = language

    // 总是用英文生成摘要（节省成本），然后如果需要其他语言，再翻译
    // 使用统一的Agent层生成摘要
    generateMeetingSummary(fullTranscript, {
      contextPrompt: context_prompt,
      customSystemPrompt: useTemplate ? systemPrompt : undefined,
      language: 'en',
    })
      .then(async (englishSummary) => {
        // 更新摘要结果，将摘要保存到 JSON 对象中对应模板的键下
        console.log('💾 Saving English summary with template_id:', finalTemplateId)
        
        // 获取现有的摘要记录
        const { data: currentSummary } = await supabaseServiceRole
          .from('summary_processes')
          .select('result')
          .eq('meeting_id', id)
          .single()
        
        let resultsByTemplate: Record<string, string> = {}
        
        // 如果已有 result，尝试解析为 JSON
        if (currentSummary?.result) {
          try {
            const parsed = JSON.parse(currentSummary.result)
            if (typeof parsed === 'object' && parsed !== null) {
              resultsByTemplate = parsed
            } else {
              // 如果是旧格式（纯文本），将其保存到当前 template_id 下
              if (currentSummary.result) {
                resultsByTemplate[finalTemplateId] = currentSummary.result
              }
            }
          } catch (e) {
            // 解析失败，说明是旧格式，将其保存到当前 template_id 下
            if (currentSummary.result) {
              resultsByTemplate[finalTemplateId] = currentSummary.result
            }
          }
        }
        
        // 将英文摘要保存到对应模板的键下（作为基础版本）
        // 这是英文版本，所有其他语言版本都基于这个版本翻译
        resultsByTemplate[finalTemplateId] = englishSummary
        console.log(`✅ Saved English summary for template: ${finalTemplateId}`)
        
        // 如果请求的语言不是英文，翻译英文摘要
        let finalSummary = englishSummary
        if (requestedLanguage !== 'en') {
          try {
            console.log(`🌐 Translating English summary to ${requestedLanguage}...`)
            finalSummary = await translateText(englishSummary, requestedLanguage)
            // 同时保存翻译版本（使用 template_id_language 格式）
            resultsByTemplate[`${finalTemplateId}_${requestedLanguage}`] = finalSummary
            console.log(`✅ Translation completed and saved for ${finalTemplateId}_${requestedLanguage}`)
          } catch (e) {
            console.error(`❌ Failed to translate summary to ${requestedLanguage}:`, e)
            // 如果翻译失败，使用英文版本
            finalSummary = englishSummary
          }
        } else {
          console.log(`ℹ️ Requested language is English, no translation needed`)
        }
        
        // 更新摘要结果
        await supabaseServiceRole
          .from('summary_processes')
          .update({
            status: 'completed',
            result: JSON.stringify(resultsByTemplate),
            template_id: finalTemplateId  // 当前活动的模板 ID
          })
          .eq('meeting_id', id)
      })
      .catch(async (error) => {
        console.error('Error generating summary:', error)
        // 更新状态为失败
        await supabaseServiceRole
          .from('summary_processes')
          .update({
            status: 'failed',
            error_message: error.message
          })
          .eq('meeting_id', id)
      })
    
    // 立即返回processing状态
    const { data: summary } = await supabaseServiceRole
      .from('summary_processes')
      .select('*')
      .eq('meeting_id', id)
      .single()
    
    return NextResponse.json({ summary })
  } catch (error: any) {
    console.error('Error in POST /api/meetings/[id]/summary:', error)
    
    // 更新状态为失败
    try {
      const { id } = await params
      const { supabaseServiceRole } = await createClients()
      await supabaseServiceRole
        .from('summary_processes')
        .update({
          status: 'failed',
          error_message: error.message
        })
        .eq('meeting_id', id)
    } catch (e) {
      // 忽略更新错误
    }
    
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// PATCH /api/meetings/[id]/summary - 更新摘要内容
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { supabaseServiceRole } = await createClients()
    const body = await request.json()
    
    const { result, template_id } = body
    
    // 获取现有的摘要记录
    const { data: currentSummary } = await supabaseServiceRole
      .from('summary_processes')
      .select('result, template_id')
      .eq('meeting_id', id)
      .single()
    
    if (!currentSummary) {
      return NextResponse.json({ error: 'Summary not found' }, { status: 404 })
    }
    
    // 确定要更新的模板 ID（优先使用传入的，否则使用当前记录的）
    const targetTemplateId = template_id || currentSummary.template_id || 'standard'
    
    let resultsByTemplate: Record<string, string> = {}
    
    // 如果已有 result，尝试解析为 JSON
    if (currentSummary.result) {
      try {
        const parsed = JSON.parse(currentSummary.result)
        if (typeof parsed === 'object' && parsed !== null) {
          resultsByTemplate = parsed
        } else {
          // 如果是旧格式（纯文本），将其保存到当前 template_id 下
          if (currentSummary.result) {
            const oldTemplateId = currentSummary.template_id || 'standard'
            resultsByTemplate[oldTemplateId] = currentSummary.result
          }
        }
      } catch (e) {
        // 解析失败，说明是旧格式，将其保存到当前 template_id 下
        if (currentSummary.result) {
          const oldTemplateId = currentSummary.template_id || 'standard'
          resultsByTemplate[oldTemplateId] = currentSummary.result
        }
      }
    }
    
    // 更新对应模板的摘要
    resultsByTemplate[targetTemplateId] = result
    
    // 更新数据库
    const { data, error } = await supabaseServiceRole
      .from('summary_processes')
      .update({
        result: JSON.stringify(resultsByTemplate),
        template_id: targetTemplateId
      })
      .eq('meeting_id', id)
      .select()
      .single()
    
    if (error) {
      console.error('Error updating summary:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    // 返回更新后的摘要，包含当前模板的内容
    return NextResponse.json({
      summary: {
        ...data,
        result: resultsByTemplate[targetTemplateId],
        template_id: targetTemplateId
      }
    })
  } catch (error: any) {
    console.error('Error in PATCH /api/meetings/[id]/summary:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}



