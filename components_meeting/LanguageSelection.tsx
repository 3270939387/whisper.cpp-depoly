'use client'

import { useState, useEffect } from 'react'
import { Languages } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  getLanguagePreference,
  setLanguagePreference,
  getLanguageDisplayName,
  LANGUAGES,
  type TranscriptionLanguage,
} from '@/utils/transcription-language'
import { toast } from 'sonner'

interface LanguageSelectionProps {
  onLanguageChange?: (language: TranscriptionLanguage) => void
  className?: string
}

export default function LanguageSelection({ 
  onLanguageChange,
  className = '' 
}: LanguageSelectionProps) {
  const [selectedLanguage, setSelectedLanguage] = useState<TranscriptionLanguage>('auto')

  // 加载保存的语言偏好
  useEffect(() => {
    const saved = getLanguagePreference()
    setSelectedLanguage(saved)
  }, [])

  const handleLanguageChange = (value: string) => {
    const language = value as TranscriptionLanguage
    setSelectedLanguage(language)
    setLanguagePreference(language)
    onLanguageChange?.(language)
    toast.success(`Language set to: ${getLanguageDisplayName(language)}`)
  }

  // 将语言列表分组：特殊选项 + 按字母顺序排列的其他语言
  const specialOptions = LANGUAGES.filter(l => 
    l.code === 'auto' || l.code === 'auto-translate'
  )
  const regularLanguages = LANGUAGES.filter(l => 
    l.code !== 'auto' && l.code !== 'auto-translate'
  ).sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <Languages className="w-4 h-4 text-gray-500" />
      <Select
        value={selectedLanguage}
        onValueChange={handleLanguageChange}
      >
        <SelectTrigger className="w-[280px]">
          <SelectValue>
            <span className="text-sm">
              {getLanguageDisplayName(selectedLanguage)}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-[400px]">
          {/* 特殊选项 */}
          {specialOptions.map((lang) => (
            <SelectItem key={lang.code} value={lang.code}>
              <div className="flex flex-col">
                <span className="font-medium">{lang.name}</span>
                {lang.code === 'auto' && (
                  <span className="text-xs text-gray-500">
                    Automatically detect the spoken language
                  </span>
                )}
                {lang.code === 'auto-translate' && (
                  <span className="text-xs text-gray-500">
                    Detect language and translate to English
                  </span>
                )}
              </div>
            </SelectItem>
          ))}
          
          {/* 分隔线 */}
          <div className="border-t my-1" />
          
          {/* 常规语言列表 */}
          {regularLanguages.map((lang) => (
            <SelectItem key={lang.code} value={lang.code}>
              {lang.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

