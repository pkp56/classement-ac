'use strict';
const crypto=require('crypto');
const auth=require('../events/api');
const COOKIE='__Host-gdsp_admin';
const DEV_COOKIE='gdsp_dev_admin';
const SAFE=new Set(['GET','HEAD','OPTIONS']);
function localHttp(req){
  return !req.secure && ['localhost','127.0.0.1','[::1]'].includes(req.hostname) && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip);
}
function cookieName(req){return localHttp(req)?DEV_COOKIE:COOKIE;}
function readCookie(req){
  if(!req.secure&&!localHttp(req))return '';
  const name=cookieName(req);
  const values=String(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));
  if(values.length!==1)return '';
  try{return decodeURIComponent(values[0].slice(name.length+1))}catch(e){return ''}
}
function csrf(token){return crypto.createHmac('sha256',token).update('gdsp-csrf-v1').digest('hex');}
function equal(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function sameOrigin(req){
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  if(!req.headers.origin)return true; // fetch same-origin et clients non navigateur
  try{return new URL(req.headers.origin).origin===req.protocol+'://'+req.get('host')}catch(e){return false}
}
function setSession(req,res,token){
  res.cookie(cookieName(req),token,{httpOnly:true,secure:!localHttp(req),sameSite:'strict',path:'/',maxAge:auth.TOKEN_TTL_SECONDS*1000});
}
function clearSession(req,res){res.clearCookie(cookieName(req),{httpOnly:true,secure:!localHttp(req),sameSite:'strict',path:'/'});}
function mountAdminSession(app,{source=()=> 'local',now=()=>Date.now()}={}){
  // Limite fixe par IP, avant bcrypt, mémoire bornée. Réinitialisée au redémarrage.
  const attempts=new Map(),WINDOW=15*60*1000,MAX=10;
  app.use('/api',(req,res,next)=>{
    const token=readCookie(req);
    if(token&&auth.verifyAdminToken('Bearer '+token).ok){
      // Une session navigateur prend priorité : pas de contournement CSRF par Bearer ajouté.
      req.headers.authorization='Bearer '+token;
      req.adminCookie=true;
      if(!SAFE.has(req.method)&&(!sameOrigin(req)||!equal(req.headers['x-gdsp-csrf'],csrf(token))))return res.status(403).json({error:'Protection CSRF : recharge la page puis réessaie.',code:'csrf-rejected'});
    }
    next();
  });
  app.post('/api/admin/login',async(req,res,next)=>{
    if(!sameOrigin(req))return res.status(403).json({error:'Origine de connexion refusée.',code:'csrf-rejected'});
    const browser=req.headers['x-gdsp-session']==='cookie';
    if(browser&&!req.secure&&!localHttp(req))return res.status(400).json({error:'Utilise HTTPS pour te connecter.',code:'https-required'});
    const time=now();
    for(const [ip,entry] of attempts)if(entry.until<=time)attempts.delete(ip);
    const key=req.ip;
    let entry=attempts.get(key);
    if(!entry){
      if(attempts.size>=10000)return res.set('Retry-After','60').status(429).json({error:'Trop de connexions. Réessaie plus tard.',code:'login-rate-limited'});
      entry={count:0,until:time+WINDOW};attempts.set(key,entry);
    }
    if(entry.count>=MAX)return res.set('Retry-After',String(Math.max(1,Math.ceil((entry.until-time)/1000)))).status(429).json({error:'Trop de tentatives. Réessaie dans quelques minutes.',code:'login-rate-limited'});
    entry.count++;
    // Compatibilité des clients API Bearer ; ils subissent aussi la limite et le contrôle Origin.
    if(!browser)return next();
    if(source()!=='local')return res.status(503).json({error:'La connexion navigateur sécurisée nécessite EVENTS_SOURCE=local.',code:'local-auth-required'});
    try{
      const username=String(req.body?.username||''),password=String(req.body?.password||'');
      if(username.length>200||password.length>1024)return res.status(401).json({error:'Identifiants refusés.'});
      const check=await auth.checkCredentials(username,password);
      if(!check.ok)return res.status(401).json({error:check.error});
      const token=auth.signAdminToken(check.user);
      setSession(req,res,token);
      res.json({authenticated:true,user:check.user,csrfToken:csrf(token),expiresIn:auth.TOKEN_TTL_SECONDS});
    }catch(e){res.status(503).json({error:'Connexion temporairement indisponible.',code:'auth-unavailable'});}
  });
  app.get('/api/admin/session',(req,res)=>{
    const token=readCookie(req),check=auth.verifyAdminToken(token?'Bearer '+token:'');
    if(!check.ok)return res.status(401).json({authenticated:false});
    res.json({authenticated:true,user:check.user,csrfToken:csrf(token)});
  });
  app.post('/api/admin/logout',(req,res)=>{
    clearSession(req,res);res.json({ok:true});
  });
}
module.exports={mountAdminSession};
