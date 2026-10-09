// Decorators the gateway's handler names resolve through.
export const Controller = () => (target: unknown) => target
export const Post = (_path: string) => (..._args: unknown[]) => undefined
export const Get = (_path: string) => (..._args: unknown[]) => undefined
export const Body = () => (..._args: unknown[]) => undefined
export const Param = (_name: string) => (..._args: unknown[]) => undefined
export const Session = () => (..._args: unknown[]) => undefined
