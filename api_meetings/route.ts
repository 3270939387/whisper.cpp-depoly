import { NextRequest, NextResponse } from 'next/server'
import { createClients } from '@/utils/supabase/server'

// GET /api/meetings - 获取所有会议列表
export async function GET(request: NextRequest) {
  try {
    const { supabaseServiceRole } = await createClients()
    
    const { data, error } = await supabaseServiceRole
      .from('meetings')
      .select('*')
      .order('created_at', { ascending: false })
    
    if (error) {
      console.error('Error fetching meetings:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json({ meetings: data || [] })
  } catch (error: any) {
    console.error('Error in GET /api/meetings:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// POST /api/meetings - 创建新会议
export async function POST(request: NextRequest) {
  try {
    const { supabaseServiceRole } = await createClients()
    const body = await request.json()
    
    const { title, audio_file_path, audio_duration, metadata } = body
    
    const { data, error } = await supabaseServiceRole
      .from('meetings')
      .insert({
        title: title || `Meeting ${new Date().toLocaleString()}`,
        audio_file_path,
        audio_duration,
        metadata,
        status: 'recording'
      })
      .select()
      .single()
    
    if (error) {
      console.error('Error creating meeting:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json({ meeting: data })
  } catch (error: any) {
    console.error('Error in POST /api/meetings:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}



