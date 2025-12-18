/**
 * 音频静音检测工具
 * 通过计算音频的 RMS (Root Mean Square) 值来判断是否为静音
 */

import { spawn } from 'child_process'
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * 检测音频文件是否为静音
 * @param audioFile - 音频文件 (File 对象)
 * @param threshold - RMS 阈值，默认 0.02 (可根据实际情况调整)
 * @returns Promise<boolean> - true 表示是静音，false 表示有声音
 */
export async function isAudioSilent(
  audioFile: File,
  threshold: number = 0.05
): Promise<boolean> {
  try {
    // 将 File 转换为 Buffer
    const arrayBuffer = await audioFile.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    // 创建临时文件
    const tempDir = tmpdir()
    const tempInputPath = join(tempDir, `audio-${Date.now()}-${Math.random().toString(36).substring(7)}.${getFileExtension(audioFile.name, audioFile.type)}`)
    const tempOutputPath = join(tempDir, `audio-rms-${Date.now()}-${Math.random().toString(36).substring(7)}.txt`)

    try {
      // 写入临时文件
      writeFileSync(tempInputPath, buffer)

      // 使用 ffmpeg 计算音频的 RMS 值
      // ffmpeg -i input.wav -af "volumedetect" -f null /dev/null 2>&1 | grep mean_volume
      const rms = await calculateRMSWithFFmpeg(tempInputPath)

      console.log('🔊 音频 RMS 检测结果:', {
        rms,
        threshold,
        isSilent: rms < threshold,
        fileName: audioFile.name,
        fileSize: audioFile.size
      })

      return rms < threshold
    } finally {
      // 清理临时文件
      try {
        if (existsSync(tempInputPath)) {
          unlinkSync(tempInputPath)
        }
        if (existsSync(tempOutputPath)) {
          unlinkSync(tempOutputPath)
        }
      } catch (e) {
        // 忽略清理错误
      }
    }
  } catch (error) {
    console.error('❌ 音频静音检测失败:', error)
    // 如果检测失败，默认不认为是静音（继续处理）
    return false
  }
}

/**
 * 使用 FFmpeg 计算音频的 RMS 值
 */
function calculateRMSWithFFmpeg(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // 使用 ffmpeg 的 volumedetect 滤镜来检测音频音量
    // mean_volume 表示平均音量（dB），我们需要将其转换为线性值
    const ffmpeg = spawn('ffmpeg', [
      '-i', audioPath,
      '-af', 'volumedetect',
      '-f', 'null',
      '-'
    ])

    let stderrOutput = ''

    ffmpeg.stderr.on('data', (data) => {
      stderrOutput += data.toString()
    })

    ffmpeg.on('close', (code) => {
      if (code !== 0 && code !== 1) {
        // ffmpeg 在 volumedetect 模式下可能返回非零退出码，但这是正常的
        // 只要我们能从 stderr 中提取到信息即可
      }

      // 从输出中提取 mean_volume 值
      // 格式: mean_volume: -XX.X dB
      const meanVolumeMatch = stderrOutput.match(/mean_volume:\s*(-?\d+\.?\d*)\s*dB/)
      
      if (meanVolumeMatch) {
        const meanVolumeDb = parseFloat(meanVolumeMatch[1])
        // 将 dB 转换为线性值 (RMS)
        // RMS = 10^(dB/20)
        const rms = Math.pow(10, meanVolumeDb / 20)
        resolve(rms)
      } else {
        // 如果没有找到 mean_volume，尝试使用 max_volume
        const maxVolumeMatch = stderrOutput.match(/max_volume:\s*(-?\d+\.?\d*)\s*dB/)
        if (maxVolumeMatch) {
          const maxVolumeDb = parseFloat(maxVolumeMatch[1])
          const rms = Math.pow(10, maxVolumeDb / 20)
          resolve(rms)
        } else {
          // 如果都没有找到，返回一个很小的值（可能是静音）
          console.warn('⚠️ 无法从 ffmpeg 输出中提取音量信息，默认返回低 RMS 值')
          resolve(0.001)
        }
      }
    })

    ffmpeg.on('error', (error) => {
      // 如果 ffmpeg 不可用，返回 false（不认为是静音）
      console.error('FFmpeg 错误:', error)
      reject(error)
    })
  })
}

/**
 * 直接从音频 Buffer 计算 RMS（适用于 WAV 格式）
 * 这是一个备用方案，如果 ffmpeg 不可用
 */
export function calculateRMSFromBuffer(buffer: Buffer, sampleRate: number = 16000): number {
  try {
    // 解析 WAV 文件头
    // WAV 文件格式: RIFF header (12 bytes) + fmt chunk + data chunk
    const dataOffset = 44 // 标准 WAV 文件头大小
    const dataLength = buffer.length - dataOffset
    
    if (dataLength <= 0) {
      return 0
    }

    // 读取 16-bit PCM 数据
    const samples: number[] = []
    for (let i = dataOffset; i < buffer.length - 1; i += 2) {
      const sample = buffer.readInt16LE(i) / 32768.0 // 归一化到 [-1, 1]
      samples.push(sample)
    }

    if (samples.length === 0) {
      return 0
    }

    // 计算 RMS
    let sumSquares = 0
    for (const sample of samples) {
      sumSquares += sample * sample
    }
    const rms = Math.sqrt(sumSquares / samples.length)

    return rms
  } catch (error) {
    console.error('从 Buffer 计算 RMS 失败:', error)
    return 0
  }
}

/**
 * 获取文件扩展名
 */
function getFileExtension(fileName: string, mimeType?: string): string {
  if (fileName && fileName.includes('.')) {
    const parts = fileName.split('.')
    return parts[parts.length - 1]
  }
  
  if (mimeType) {
    const mimeToExt: Record<string, string> = {
      'audio/webm': 'webm',
      'audio/wav': 'wav',
      'audio/wave': 'wav',
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/ogg': 'ogg',
      'audio/opus': 'opus'
    }
    return mimeToExt[mimeType] || 'webm'
  }
  
  return 'webm'
}

/**
 * 简化的静音检测（使用 Buffer 直接计算，仅适用于 WAV）
 * 如果音频是 WAV 格式，可以直接使用这个方法，避免调用 ffmpeg
 */
export async function isAudioSilentSimple(
  audioFile: File,
  threshold: number = 0.02
): Promise<boolean> {
  try {
    const arrayBuffer = await audioFile.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    // 检查是否是 WAV 格式
    const isWAV = audioFile.type?.includes('wav') || 
                  audioFile.name?.toLowerCase().endsWith('.wav') ||
                  buffer.toString('ascii', 0, 4) === 'RIFF'

    if (isWAV) {
      // 直接计算 RMS
      const rms = calculateRMSFromBuffer(buffer)
      console.log('🔊 音频 RMS 检测结果 (直接计算):', {
        rms,
        threshold,
        isSilent: rms < threshold,
        fileName: audioFile.name
      })
      return rms < threshold
    } else {
      // 非 WAV 格式，使用 ffmpeg
      return await isAudioSilent(audioFile, threshold)
    }
  } catch (error) {
    console.error('❌ 音频静音检测失败:', error)
    return false
  }
}

