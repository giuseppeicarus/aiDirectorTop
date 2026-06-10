import { describe, expect, it } from 'vitest'

import { parseGlobalActivity } from './globalActivityMessages'

describe('parseGlobalActivity reel identity', () => {
  it('shows the reel title instead of the standalone storage id', () => {
    const activity = parseGlobalActivity('reel:progress', {
      job_id: 'job-1',
      title: 'una morena',
      catalog_project_id: 'reel_standalone',
      event: 'progress',
      msg: 'Storyboard anteprima',
    })

    expect(activity.source).toBe('Reel · una morena')
    expect(activity.message).toBe('Storyboard anteprima del reel una morena')
    expect(activity.message).not.toContain('standalone')
  })

  it('does not expose a standalone id when no title is available', () => {
    const activity = parseGlobalActivity('reel:progress', {
      job_id: 'job-2',
      project_id: 'reel_standalone',
      event: 'progress',
      msg: 'Avvio',
    })

    expect(activity.message).toBe('Avvio')
    expect(activity.message).not.toContain('standalone')
  })
})
