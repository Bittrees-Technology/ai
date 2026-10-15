import {useEffect} from 'react';

// No identity, email code, signature or session token is stored in JavaScript.
export function useSharedSignIn(sessionRevision) {
  useEffect(()=>{
    if(location.pathname.startsWith('/connect/')||location.pathname.startsWith('/api/'))return;
    const controller=new AbortController();
    fetch('/api/sso/status',{credentials:'same-origin',cache:'no-store',signal:controller.signal})
      .then(r=>r.ok?r.json():null).then(result=>{
        if(controller.signal.aborted||!result?.configured||!['publish','resume'].includes(result.action))return;
        const query=new URLSearchParams({mode:result.action,return_to:location.pathname+location.search+location.hash});
        location.replace('/api/sso/start?'+query);
      }).catch(()=>{});
    return ()=>controller.abort();
  },[sessionRevision]);
}
