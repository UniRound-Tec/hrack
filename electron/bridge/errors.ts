import { BRIDGE_ERROR, type BridgeErrorBody } from '../../shared/bridge-protocol'

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: 1 | 2 = 1
  ) {
    super(message)
    this.name = 'BridgeError'
  }

  toBody(): BridgeErrorBody {
    return { code: this.code, message: this.message }
  }

  static invalid(message: string): BridgeError {
    return new BridgeError(BRIDGE_ERROR.invalid, message)
  }

  static notFound(message: string): BridgeError {
    return new BridgeError(BRIDGE_ERROR.notFound, message)
  }

  static notAllowed(message: string): BridgeError {
    return new BridgeError(BRIDGE_ERROR.notAllowed, message)
  }

  static unavailable(message: string, exitCode: 1 | 2 = 1): BridgeError {
    return new BridgeError(BRIDGE_ERROR.unavailable, message, exitCode)
  }

  static unauthorized(message: string): BridgeError {
    return new BridgeError(BRIDGE_ERROR.unauthorized, message)
  }

  static uncontrolled(message: string): BridgeError {
    return new BridgeError(BRIDGE_ERROR.uncontrolled, message)
  }

  static timeout(message: string): BridgeError {
    return new BridgeError(BRIDGE_ERROR.timeout, message)
  }

  static notImplemented(command: string): BridgeError {
    return new BridgeError(
      BRIDGE_ERROR.notImplemented,
      `${command} is not implemented yet (P2)`
    )
  }

  static disconnected(message: string): BridgeError {
    return new BridgeError(BRIDGE_ERROR.disconnected, message, 2)
  }
}

export function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new BridgeError(BRIDGE_ERROR.unavailable, message)
}
