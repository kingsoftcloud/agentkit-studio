/** A late Session/binding lookup cannot grant authority after cancellation. */
export async function nativeRecoveryLive(operation, signal) {
  signal.throwIfAborted();
  let abort;
  const stopped=new Promise((_,reject)=>{
    abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
  });
  try {
    const value=await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}),stopped]);
    signal.throwIfAborted();return value;
  } finally {signal.removeEventListener('abort',abort);}
}
