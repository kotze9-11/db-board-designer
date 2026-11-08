// Rope Rescue Planner, website only: sign-in and AI drawing reading through
// the same Supabase project and "read-board" function as DB Board Designer.
(function(){
  const cfg=window.DBB_CONFIG;
  if(!cfg||!window.supabase||!window.supabase.createClient) return;
  const sb=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  window.RRP_CLOUD={
    async signedIn(){try{const {data}=await sb.auth.getSession();return !!(data&&data.session)}catch(e){return false}},
    async signIn(email,password){
      const {error}=await sb.auth.signInWithPassword({email,password});
      if(error) throw {userMessage:/invalid/i.test(error.message)?"Wrong email or password.":error.message};
    },
    async readDrawing(b64,extra){
      const {data,error}=await sb.functions.invoke("read-board",{body:{mode:"drawing",images:[{data:b64,mediaType:"image/jpeg"}],extra}});
      if(error){
        let info=null;
        try{info=error.context&&typeof error.context.json==="function"?await error.context.json():null}catch(e){}
        throw {code:(info&&info.code)||"upstream_error",userMessage:(info&&info.error)||"The AI isn't working right now. Check your internet connection and try again."};
      }
      if(!data||!data.reading) throw {code:"invalid_json",userMessage:"The AI's answer couldn't be read. Try again."};
      return data.reading;
    }
  };
})();
