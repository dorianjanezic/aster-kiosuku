declare module 'debug' {
    interface Debugger {
        (formatter: any, ...args: any[]): void;
        extend: (subspace: string) => Debugger;
        enabled?: boolean;
        namespace?: string;
        log?: (...args: any[]) => void;
    }
    function createDebug(namespace: string): Debugger;
    export default createDebug;
}

