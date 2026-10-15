/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { isAxiosError } from 'axios'
import { createAxiosDaytonaError, DaytonaError } from '../errors/DaytonaError'

/** Keep recovery classification without carrying storage credentials into SDK spans. */
export function buildContextError(error: unknown, message: string): DaytonaError {
  if (isAxiosError(error)) error = createAxiosDaytonaError(error)
  if (error instanceof DaytonaError) {
    const ErrorClass = error.constructor as typeof DaytonaError
    return new ErrorClass(message, error.statusCode)
  }
  return new DaytonaError(message)
}
