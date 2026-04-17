'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  VideoGenerationOptions,
  VideoModelOption,
  VideoPanel,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video'
import {
  normalizeVideoGenerationSelections,
  resolveEffectiveVideoCapabilityDefinitions,
  resolveEffectiveVideoCapabilityFields,
} from '@/lib/model-capabilities/video-effective'
import { supportsFirstLastFrame } from '@/lib/model-capabilities/video-model-options'
import { projectVideoPricingTiersByFixedSelections } from '@/lib/model-pricing/video-tier'
import { useUpdatePanelDuration } from '@/lib/query/hooks'

interface FirstLastFrameCapabilityField {
  field: string
  label: string
  options: VideoGenerationOptionValue[]
  disabledOptions?: VideoGenerationOptionValue[]
  value: VideoGenerationOptionValue | undefined
}

type VideoGenerationOptionValue = string | number | boolean

function parseByOptionType(
  input: string,
  sample: VideoGenerationOptionValue,
): VideoGenerationOptionValue {
  if (typeof sample === 'number') return Number(input)
  if (typeof sample === 'boolean') return input === 'true'
  return input
}

function toFieldLabel(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase())
}

interface UseVideoFirstLastFrameFlowParams {
  allPanels: VideoPanel[]
  linkedPanels: Map<string, boolean>
  videoModelOptions: VideoModelOption[]
  projectId?: string
  onGenerateVideo: (
    storyboardId: string,
    panelIndex: number,
    videoModel?: string,
    firstLastFrame?: {
      lastFrameStoryboardId: string
      lastFramePanelIndex: number
      flModel: string
      customPrompt?: string
    },
    generationOptions?: VideoGenerationOptions,
    panelId?: string,
  ) => Promise<void>
  t: (key: string) => string
}

export function useVideoFirstLastFrameFlow({
  allPanels,
  linkedPanels,
  videoModelOptions,
  projectId,
  onGenerateVideo,
  t,
}: UseVideoFirstLastFrameFlowParams) {
  const updatePanelDurationMutation = useUpdatePanelDuration(projectId || null)
  const firstLastFrameModelOptions = useMemo(
    () => videoModelOptions.filter((option) => supportsFirstLastFrame(option)),
    [videoModelOptions],
  )
  const [flModel, setFlModel] = useState(firstLastFrameModelOptions[0]?.value || '')
  // 🔥 为每个 panel 存储独立的 generationOptions（key: panelKey）
  const [flGenerationOptionsByPanel, setFlGenerationOptionsByPanel] = useState<Map<string, VideoGenerationOptions>>(new Map())
  // 默认的 generationOptions（作为后备值，当 panel 没有独立选项时使用）
  const flGenerationOptionsRef = useRef<VideoGenerationOptions>({})
  const flGenerationOptions = flGenerationOptionsRef.current
  const [flCustomPrompts, setFlCustomPrompts] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    setFlCustomPrompts((previous) => {
      const next = new Map(previous)
      const existingPanelKeys = new Set<string>()

      for (const panel of allPanels) {
        const panelKey = `${panel.storyboardId}-${panel.panelIndex}`
        existingPanelKeys.add(panelKey)
        if (!next.has(panelKey)) {
          next.set(panelKey, panel.firstLastFramePrompt || '')
        }
      }

      for (const key of next.keys()) {
        if (!existingPanelKeys.has(key)) next.delete(key)
      }

      return next
    })
  }, [allPanels])

  // 🔥 初始化每个 panel 的 flGenerationOptions，优先使用 panel.duration
  useEffect(() => {
    setFlGenerationOptionsByPanel((previous) => {
      const next = new Map(previous)
      const existingPanelKeys = new Set<string>()

      for (const panel of allPanels) {
        const panelKey = `${panel.storyboardId}-${panel.panelIndex}`
        existingPanelKeys.add(panelKey)
        if (!next.has(panelKey)) {
          // 如果 panel 有 duration，用它来初始化
          const initialOptions: VideoGenerationOptions = typeof panel.duration === 'number' && panel.duration > 0
            ? { duration: panel.duration }
            : {}
          next.set(panelKey, initialOptions)
        }
      }

      // 清理不存在的 panel
      for (const key of next.keys()) {
        if (!existingPanelKeys.has(key)) next.delete(key)
      }

      return next
    })
  }, [allPanels])

  useEffect(() => {
    if (!flModel && firstLastFrameModelOptions.length > 0) {
      setFlModel(firstLastFrameModelOptions[0].value)
      return
    }
    if (flModel && !firstLastFrameModelOptions.some((option) => option.value === flModel)) {
      setFlModel(firstLastFrameModelOptions[0]?.value || '')
    }
  }, [firstLastFrameModelOptions, flModel])

  const selectedFlModelOption = useMemo(
    () => firstLastFrameModelOptions.find((option) => option.value === flModel),
    [firstLastFrameModelOptions, flModel],
  )
  const flPricingTiers = useMemo(
    () => projectVideoPricingTiersByFixedSelections({
      tiers: selectedFlModelOption?.videoPricingTiers ?? [],
      fixedSelections: {
        generationMode: 'firstlastframe',
      },
    }),
    [selectedFlModelOption?.videoPricingTiers],
  )
  const flCapabilityDefinitions = useMemo(
    () => resolveEffectiveVideoCapabilityDefinitions({
      videoCapabilities: selectedFlModelOption?.capabilities?.video,
      pricingTiers: flPricingTiers,
    }),
    [flPricingTiers, selectedFlModelOption?.capabilities?.video],
  )

  // 当 flCapabilityDefinitions 变化时（如切换模型），重新规范化所有 panel 的选项
  // 注意：用 pinnedFields: ['duration'] 保留用户选择的时长，不使用 panel.duration（可能是旧的服务器值）
  useEffect(() => {
    if (flCapabilityDefinitions.length === 0) return
    setFlGenerationOptionsByPanel((previous) => {
      const next = new Map(previous)
      let changed = false
      for (const [panelKey, existingOptions] of next.entries()) {
        const normalized = normalizeVideoGenerationSelections({
          definitions: flCapabilityDefinitions,
          pricingTiers: flPricingTiers,
          selection: existingOptions,
          pinnedFields: ['duration'],
        })
        if (JSON.stringify(normalized) !== JSON.stringify(existingOptions)) {
          next.set(panelKey, normalized)
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [flCapabilityDefinitions, flPricingTiers])

  const flDefinitionFieldMap = useMemo(
    () => new Map(flCapabilityDefinitions.map((definition) => [definition.field, definition])),
    [flCapabilityDefinitions],
  )

  // 🔥 根据 per-panel 的 selection 计算每个 panel 的 capabilityFields（正确的 enabled/disabled）
  const getFlCapabilityFields = useCallback((panelKey: string): FirstLastFrameCapabilityField[] => {
    const panelOptions = flGenerationOptionsByPanel.get(panelKey) || flGenerationOptions
    const effectiveFields = resolveEffectiveVideoCapabilityFields({
      definitions: flCapabilityDefinitions,
      pricingTiers: flPricingTiers,
      selection: panelOptions,
    })
    return flCapabilityDefinitions.map((definition) => {
      const effectiveField = effectiveFields.find((f) => f.field === definition.field)
      const enabledOptions = effectiveField?.options ?? []
      return {
        field: definition.field,
        label: toFieldLabel(definition.field),
        options: definition.options as VideoGenerationOptionValue[],
        disabledOptions: (definition.options as VideoGenerationOptionValue[])
          .filter((option) => !enabledOptions.includes(option)),
        value: effectiveField?.value as VideoGenerationOptionValue | undefined,
      }
    })
  }, [flCapabilityDefinitions, flPricingTiers, flGenerationOptionsByPanel, flGenerationOptions])

  // 🔥 根据 per-panel 的 selection 计算 missing fields
  const getFlMissingCapabilityFields = useCallback((panelKey: string): string[] => {
    const panelOptions = flGenerationOptionsByPanel.get(panelKey) || flGenerationOptions
    const effectiveFields = resolveEffectiveVideoCapabilityFields({
      definitions: flCapabilityDefinitions,
      pricingTiers: flPricingTiers,
      selection: panelOptions,
    })
    return effectiveFields
      .filter((field) => field.options.length === 0 || field.value === undefined)
      .map((field) => field.field)
  }, [flCapabilityDefinitions, flPricingTiers, flGenerationOptionsByPanel, flGenerationOptions])

  const setFlCapabilityValue = useCallback((panelKey: string, field: string, rawValue: string) => {
    const definitionField = flDefinitionFieldMap.get(field)
    if (!definitionField || definitionField.options.length === 0) return
    const parsedValue = parseByOptionType(rawValue, definitionField.options[0])
    if (!definitionField.options.includes(parsedValue)) return

    setFlGenerationOptionsByPanel((previous) => {
      const next = new Map(previous)
      const currentOptions = next.get(panelKey) || {}
      const updated = normalizeVideoGenerationSelections({
        definitions: flCapabilityDefinitions,
        pricingTiers: flPricingTiers,
        selection: {
          ...currentOptions,
          [field]: parsedValue,
        },
        pinnedFields: [field],
      })
      next.set(panelKey, updated)
      return next
    })

    // 🔥 同步 duration 到数据库
    if (field === 'duration' && projectId) {
      const panel = allPanels.find(p => `${p.storyboardId}-${p.panelIndex}` === panelKey)
      if (panel?.panelId) {
        updatePanelDurationMutation.mutate({
          panelId: panel.panelId,
          duration: typeof parsedValue === 'number' ? parsedValue : null,
        })
      }
    }
  }, [flCapabilityDefinitions, flDefinitionFieldMap, flPricingTiers, projectId, allPanels, updatePanelDurationMutation])

  const setFlCustomPrompt = useCallback((panelKey: string, value: string) => {
    setFlCustomPrompts((previous) => new Map(previous).set(panelKey, value))
  }, [])

  const resetFlCustomPrompt = useCallback((panelKey: string) => {
    setFlCustomPrompts((previous) => {
      const next = new Map(previous)
      next.delete(panelKey)
      return next
    })
  }, [])

  const handleGenerateFirstLastFrame = useCallback(async (
    firstStoryboardId: string,
    firstPanelIndex: number,
    lastStoryboardId: string,
    lastPanelIndex: number,
    panelKey: string,
    generationOptions?: VideoGenerationOptions,
    firstPanelId?: string,
  ) => {
    const persistedCustomPrompt = allPanels.find(
      (panel) =>
        panel.storyboardId === firstStoryboardId
        && panel.panelIndex === firstPanelIndex,
    )?.firstLastFramePrompt
    const customPrompt = flCustomPrompts.get(panelKey) ?? persistedCustomPrompt
    // 🔥 使用特定 panel 的 options，如果没有则传入的 options
    const panelOptions = flGenerationOptionsByPanel.get(panelKey) || generationOptions || flGenerationOptions
    await onGenerateVideo(firstStoryboardId, firstPanelIndex, flModel, {
      lastFrameStoryboardId: lastStoryboardId,
      lastFramePanelIndex: lastPanelIndex,
      flModel,
      customPrompt,
    }, panelOptions, firstPanelId)
  }, [allPanels, flCustomPrompts, flGenerationOptionsByPanel, flGenerationOptions, flModel, onGenerateVideo])

  const getDefaultFlPrompt = useCallback((firstPrompt?: string, lastPrompt?: string): string => {
    const first = firstPrompt || ''
    const last = lastPrompt || ''
    if (last) {
      return `${first} ${t('firstLastFrame.thenTransitionTo')}: ${last}`
    }
    return first
  }, [t])

  const getNextPanel = useCallback((currentIndex: number): VideoPanel | null => {
    if (currentIndex >= allPanels.length - 1) return null
    return allPanels[currentIndex + 1]
  }, [allPanels])

  const isLinkedAsLastFrame = useCallback((currentIndex: number): boolean => {
    if (currentIndex === 0) return false
    const previousPanel = allPanels[currentIndex - 1]
    const previousKey = `${previousPanel.storyboardId}-${previousPanel.panelIndex}`
    return linkedPanels.get(previousKey) || false
  }, [allPanels, linkedPanels])

  // 🔥 获取特定 panel 的 generationOptions
  const getFlGenerationOptions = useCallback((panelKey: string): VideoGenerationOptions => {
    return flGenerationOptionsByPanel.get(panelKey) || flGenerationOptions
  }, [flGenerationOptionsByPanel, flGenerationOptions])

  return {
    flModel,
    flModelOptions: firstLastFrameModelOptions,
    flGenerationOptions,
    flGenerationOptionsByPanel,
    getFlGenerationOptions,
    getFlCapabilityFields,
    getFlMissingCapabilityFields,
    flCustomPrompts,
    setFlModel,
    setFlCapabilityValue,
    setFlCustomPrompt,
    resetFlCustomPrompt,
    handleGenerateFirstLastFrame,
    getDefaultFlPrompt,
    getNextPanel,
    isLinkedAsLastFrame,
  }
}
