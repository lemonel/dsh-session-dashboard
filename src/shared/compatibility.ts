/** Exact released host lines covered by the isolated compatibility matrix.
 * Do not widen this list from a semver guess: host identity and lifecycle APIs
 * are authority boundaries, not optional presentation conveniences. */
export const SUPPORTED_DSH_VERSIONS = [
  '0.2.0-rc.1', '0.2.0-rc.2',
  '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.1-alpha.4',
  '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3',
] as const
export type SupportedDshVersion = typeof SUPPORTED_DSH_VERSIONS[number]
export interface HostCapabilities { version: SupportedDshVersion; principalPeers: boolean; timedQuestions: boolean }
export function hostCapabilities(version: string): HostCapabilities {
  const supported = SUPPORTED_DSH_VERSIONS.find(candidate => candidate === version)
  if (supported === undefined) throw new Error(`Unsupported DSH ${version}; supported: ${SUPPORTED_DSH_VERSIONS.join(', ')}`)
  return { version: supported,
    principalPeers: supported.startsWith('0.2.1-') && supported !== '0.2.1-alpha.1' && supported !== '0.2.1-alpha.2',
    timedQuestions: supported !== '0.2.0-rc.1' }
}
