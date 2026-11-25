import {handleApi} from './api.mjs';
import {createKVFiles} from './kv-storage.mjs';
import {runCertificateDisposal} from './certificate-disposal.mjs';

function certificateEnvironment(env) {
  return {...env,FILES:createKVFiles(env.FILES_KV),certificateRetentionEnabled:true};
}

export default {
  async fetch(request,env) {
    const response=await handleApi(request,certificateEnvironment(env));
    if(response)return response;
    const url=new URL(request.url);
    if(url.pathname==='/')return Response.redirect(new URL('/edustatus_all.html',url),302);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller,env) {
    await runCertificateDisposal(certificateEnvironment(env));
  },
};
