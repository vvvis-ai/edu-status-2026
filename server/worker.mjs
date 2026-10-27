import {handleApi} from './api.mjs';
import {createKVFiles} from './kv-storage.mjs';
export default {
  async fetch(request,env) {
    const response=await handleApi(request,{...env,FILES:createKVFiles(env.FILES_KV)});
    if(response)return response;
    const url=new URL(request.url);
    if(url.pathname==='/')return Response.redirect(new URL('/edustatus_all.html',url),302);
    return env.ASSETS.fetch(request);
  },
};
