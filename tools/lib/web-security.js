'use strict';
// Première couche compatible avec les handlers inline existants.
// Une CSP script-src stricte et les cookies HttpOnly nécessitent un lot dédié.
function securityHeaders(req,res,next){
  res.set({
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'strict-origin-when-cross-origin',
    'Permissions-Policy':'geolocation=(), microphone=(), camera=()',
    'X-Frame-Options':'SAMEORIGIN',
    'Content-Security-Policy':"base-uri 'self'; object-src 'none'; frame-ancestors 'self'"
  });
  // HTTPS direct ou signalé par un reverse proxy de confiance uniquement.
  // Durée volontairement courte, sans includeSubDomains ni preload.
  if(req.secure)res.set('Strict-Transport-Security','max-age=86400');
  if(req.path.startsWith('/api/'))res.set('Cache-Control','no-store');
  next();
}
function apiErrors(error,req,res,next){
  if(!req.path.startsWith('/api/'))return next(error);
  if(res.headersSent)return next(error);
  const status=error.type==='entity.too.large'?413:error.type==='entity.parse.failed'?400:500;
  res.status(status).json({error:status===413?'Requête trop volumineuse.':status===400?'JSON invalide.':'Erreur du service. Réessaie dans quelques instants.',code:'request-error'});
}
module.exports={securityHeaders,apiErrors};
