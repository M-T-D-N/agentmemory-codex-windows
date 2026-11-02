import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import { stopOwnedChild, type ChildIdentity } from "./helpers/owned-child.js";
const owner: ChildIdentity = { pid: 41, parent: 2, created: "start", executable: "node.exe", command: "node fixture" };
function fixture() {
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null, pid: 41,
    kill: vi.fn((_signal: string) => { child.exitCode = 0; child.emit("exit", 0); return true; }) });
  return child;
}
describe("owned fixture child termination", () => {
  it.each(["pid", "parent", "created", "executable", "command"] as const)("refuses changed %s including PID reuse", async field => {
    const child = fixture(), read = vi.fn(() => ({...owner,[field]: typeof owner[field] === "number" ? 99 : "replacement"}));
    await expect(stopOwnedChild(child as unknown as ChildProcess,owner,read,()=>{})).rejects.toThrow("refusing signal");
    expect(child.kill).not.toHaveBeenCalled();
  });
  it.each(["missing","failed"])("does not signal when identity lookup is %s", async mode => {
    const child=fixture();
    await expect(stopOwnedChild(child as unknown as ChildProcess,owner,()=>{if(mode==="failed")throw Error("synthetic");return null;},()=>{})).rejects.toThrow();
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("does not query or signal an already exited child",async()=>{
    const child=fixture();child.exitCode=0;const read=vi.fn();
    await stopOwnedChild(child as unknown as ChildProcess,owner,read,()=>{});
    expect(read).not.toHaveBeenCalled();expect(child.kill).not.toHaveBeenCalled();
  });
  it("cancels late force timers after normal exit",async()=>{
    vi.useFakeTimers();
    try{const child=fixture(),read=vi.fn(()=>owner);
      await stopOwnedChild(child as unknown as ChildProcess,owner,read,()=>{},10);
      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill.mock.calls.map(c=>c[0])).toEqual(["SIGTERM"]);expect(read).toHaveBeenCalledTimes(1);
    }finally{vi.useRealTimers();}
  });
  it("rechecks identity before escalation and refuses a replacement",async()=>{
    vi.useFakeTimers();
    try{const child=fixture();child.kill.mockImplementation(()=>true);
      const read=vi.fn().mockReturnValueOnce(owner).mockReturnValue({...owner,created:"reused"});
      const done=stopOwnedChild(child as unknown as ChildProcess,owner,read,()=>{},10);
      const assertion=expect(done).rejects.toThrow("refusing signal");
      await vi.advanceTimersByTimeAsync(10);await assertion;
      expect(child.kill.mock.calls.map(c=>c[0])).toEqual(["SIGTERM"]);
    }finally{vi.useRealTimers();}
  });
  it("checks the same owner for both signals and records exit",async()=>{
    vi.useFakeTimers();
    try{const child=fixture();child.kill.mockImplementation(signal=>{if(signal==="SIGKILL"){child.exitCode=0;child.emit("exit",0);}return true;});
      const read=vi.fn(()=>owner),events:object[]=[];
      const done=stopOwnedChild(child as unknown as ChildProcess,owner,read,event=>events.push(event),10);
      await vi.advanceTimersByTimeAsync(10);await done;
      expect(read).toHaveBeenCalledTimes(2);expect(child.kill.mock.calls.map(c=>c[0])).toEqual(["SIGTERM","SIGKILL"]);
      expect(events).toContainEqual({phase:"exited",identity:owner});
    }finally{vi.useRealTimers();}
  });
});
