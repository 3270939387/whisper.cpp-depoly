import { NextRequest, NextResponse } from 'next/server'
import { createClients } from '@/utils/supabase/server'

// GET /api/meetings/[id]/transcripts - 获取会议的所有转录
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { supabaseServiceRole } = await createClients()
    
    const { data, error } = await supabaseServiceRole
      .from('transcripts')
      .select('*')
      .eq('meeting_id', id)
      .order('audio_start_time', { ascending: true })
    
    if (error) {
      console.error('Error fetching transcripts:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json({ transcripts: data || [] })
  } catch (error: any) {
    console.error('Error in GET /api/meetings/[id]/transcripts:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// POST /api/meetings/[id]/transcripts - 添加转录
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { supabaseServiceRole } = await createClients()
    const body = await request.json()
    
    const { transcript, timestamp, audio_start_time, audio_end_time, confidence } = body
    
    const { data, error } = await supabaseServiceRole
      .from('transcripts')
      .insert({
        meeting_id: id,
        transcript,
        timestamp,
        audio_start_time,
        audio_end_time,
        confidence
      })
      .select()
      .single()
    
    if (error) {
      console.error('Error creating transcript:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json({ transcript: data })
  } catch (error: any) {
    console.error('Error in POST /api/meetings/[id]/transcripts:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}



