import { QueryClient } from '@tanstack/react-query'
import { createConveyorReactClient, type ConveyorReactClient } from 'electron-conveyor/react'
import type { AppRouter } from './router'

/** The app's TanStack Query client — created here so conveyor's typed `invalidate()` can use it. */
export const queryClient = new QueryClient()

/**
 * The typed IPC client. Every member is callable (`await conveyor.system.info()`) and carries its
 * hooks: `conveyor.system.info.useQuery()`, `conveyor.web.openUrl.useMutation()`,
 * `conveyor.window.onFocusChange.useEvent(cb)`, `conveyor.stream.respond.useStream({...})` —
 * query keys derive from the call path, so they are never written by hand.
 */
// Browser builds still import the query client and shell modules. Defer IPC creation until an
// Electron-only feature accesses it; without a preload, Conveyor throws during initialization.
let desktopClient: ConveyorReactClient<AppRouter> | undefined
export const conveyor = new Proxy({} as ConveyorReactClient<AppRouter>, {
  get(_target, property) {
    desktopClient ??= createConveyorReactClient<AppRouter>({ queryClient })
    return Reflect.get(desktopClient, property)
  },
})
