import { expect, test } from '@playwright/test'
import { PtyPauseLeases } from '../electron/pty/PtyPauseLeases'

test('only resumes PTY output after every consumer releases its pause lease', () => {
  let pauses = 0
  let resumes = 0
  const leases = new PtyPauseLeases(
    () => {
      pauses += 1
    },
    () => {
      resumes += 1
    }
  )
  const renderer = Symbol('renderer')
  const phone = Symbol('phone')

  leases.acquire(renderer)
  leases.acquire(phone)
  leases.acquire(phone)
  expect({ pauses, resumes, size: leases.size }).toEqual({
    pauses: 1,
    resumes: 0,
    size: 2
  })

  leases.release(renderer)
  expect({ pauses, resumes, size: leases.size }).toEqual({
    pauses: 1,
    resumes: 0,
    size: 1
  })
  leases.release(phone)
  expect({ pauses, resumes, size: leases.size }).toEqual({
    pauses: 1,
    resumes: 1,
    size: 0
  })
})
