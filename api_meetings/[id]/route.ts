import { NextRequest, NextResponse } from 'next/server'
import { createClients } from '@/utils/supabase/server'

// GET /api/meetings/[id] - 获取单个会议详情
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { supabaseServiceRole } = await createClients()
    
    const { data, error } = await supabaseServiceRole
      .from('meetings')
      .select('*')
      .eq('id', id)
      .single()
    
    if (error) {
      console.error('Error fetching meeting:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json({ meeting: data })
  } catch (error: any) {
    console.error('Error in GET /api/meetings/[id]:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// PATCH /api/meetings/[id] - 更新会议
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { supabaseServiceRole } = await createClients()
    const body = await request.json()
    
    const { data, error } = await supabaseServiceRole
      .from('meetings')
      .update(body)
      .eq('id', id)
      .select()
      .single()
    
    if (error) {
      console.error('Error updating meeting:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json({ meeting: data })
  } catch (error: any) {
    console.error('Error in PATCH /api/meetings/[id]:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// DELETE /api/meetings/[id] - 删除会议
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { supabaseServiceRole } = await createClients()
    
    // 先删除相关的转录和摘要
    await supabaseServiceRole.from('transcripts').delete().eq('meeting_id', id)
    await supabaseServiceRole.from('summary_processes').delete().eq('meeting_id', id)
    
    const { error } = await supabaseServiceRole
      .from('meetings')
      .delete()
      .eq('id', id)
    
    if (error) {
      console.error('Error deleting meeting:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Error in DELETE /api/meetings/[id]:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}



