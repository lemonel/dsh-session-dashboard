import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { en, zh, type TranslationKey } from './locales.js'

export type Translator = (key: TranslationKey, params?: Record<string, unknown>) => string
export interface DashboardLocaleSource {
  getSnapshot(): { active: string; revision: number }
  subscribe(listener: () => void): () => void
}
export interface DashboardLocale { t: Translator; active: string }
/** `{name}` interpolation shared by both dictionary families. */
export function interpolate(text: string, params?: Record<string, unknown>): string {
  return text.replace(/\{(\w+)\}/g, (token, name: string) => params?.[name] === undefined ? token : String(params[name]))
}
/** This fallback is only for independently rendered components/tests. The plugin
 * always supplies the host service; it never detects or writes a language itself. */
export function translateLocale(active: string): Translator {
  const dictionary = active === 'zh' ? zh : en
  return (key, params) => interpolate(dictionary[key], params)
}
export const defaultTranslator = translateLocale('zh')
const LocaleContext = createContext<DashboardLocale>({ t: defaultTranslator, active: 'zh' })
export function LocaleProvider({ source, t, children }: { source: DashboardLocaleSource; t: TranslateNS<'sessionDashboard'>; children: ReactNode }) {
  const snapshot = useSyncExternalStore(listener => source.subscribe(listener), () => source.getSnapshot(), () => source.getSnapshot())
  const value = useMemo(() => ({ t, active: snapshot.active }), [t, snapshot.active, snapshot.revision])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}
export function StaticLocaleProvider({ active, children }: { active: string; children: ReactNode }) {
  const value = useMemo(() => ({ active, t: translateLocale(active) }), [active])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}
export function useDashboardLocale(): DashboardLocale { return useContext(LocaleContext) }
export function useTranslator(): Translator { return useDashboardLocale().t }
export type { TranslationKey }
