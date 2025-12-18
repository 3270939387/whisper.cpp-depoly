/**
 * 会议模板工具函数（服务器端）
 * 只能在 API 路由中使用
 */

import fs from 'fs'
import path from 'path'
import type { MeetingTemplate } from './meeting-templates'

// 模板文件映射
const TEMPLATE_FILES: Record<string, string> = {
  'daily_standup': 'daily_standup.json',
  'project_sync': 'project_sync.json',
  'client_sales': 'sales_marketing_client_call.json',
  'standard': 'standard_meeting.json'
}

/**
 * 加载模板文件（服务器端）
 */
export async function loadTemplateServer(templateId: string): Promise<MeetingTemplate> {
  const fileName = TEMPLATE_FILES[templateId]
  if (!fileName) {
    throw new Error(`Template not found: ${templateId}`)
  }

  try {
    const templatePath = path.join(
      process.cwd(),
      'components',
      'meeting',
      'templates',
      fileName
    )

    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template file not found: ${fileName}`)
    }

    const templateContent = fs.readFileSync(templatePath, 'utf-8')
    return JSON.parse(templateContent) as MeetingTemplate
  } catch (error: any) {
    throw new Error(`Failed to load template ${templateId}: ${error.message}`)
  }
}

