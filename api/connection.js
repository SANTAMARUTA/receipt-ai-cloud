export const config = { runtime: 'edge' };
export default function handler(req) {
 const headers = {'Content-Type':'application/json','Cache-Control':'no-store'};
 if(req.method !== 'GET') return new Response('{}',{status:405,headers});
 let iceServers = [{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];
 try {
  if(process.env.TURN_ICE_SERVERS) {
   const turn = JSON.parse(process.env.TURN_ICE_SERVERS);
   if(!Array.isArray(turn) || !turn.length || turn.some(s=>!s || !(typeof s.urls==='string'||Array.isArray(s.urls)))) throw new Error();
   iceServers = iceServers.concat(turn);
  }
 } catch { return new Response(JSON.stringify({error:'TURN_ICE_SERVERSのJSON設定が不正です。'}),{status:503,headers}); }
 return new Response(JSON.stringify({iceServers}),{headers});
}
