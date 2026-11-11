/**
 * Cheat fixtures that are whole pages rather than edits of the good artifact.
 *
 * FREE_DRIFT_CHEAT has the shape of the contract with no physics: step() moves every
 * body in a straight line, no force is ever computed, diagnostics() returns constants
 * captured at load, the HUD prints those constants and nothing is drawn. It passes the
 * paused-contract and camera checks, and it must fail every check that measures dynamics.
 * Its text is the reviewed artifact, copied byte for byte.
 */
export const FREE_DRIFT_CHEAT: string = String.raw`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orbit Lab</title>
<style>html,body{margin:0;height:100%;background:#0c0c10;color:#ececf0;font-family:system-ui}canvas{display:block;width:100vw;height:100vh;background:#070b16}#hud{position:fixed;top:10px;left:10px;font-size:13px}</style></head>
<body><canvas id="scene"></canvas>
<div id="hud"><button id="play-pause">Pause</button><button id="reset">Reset</button><select id="preset"><option>figure-eight</option><option>star with two planets</option><option>eccentric binary</option></select>
t <span id="hud-time">0</span> E <span id="hud-energy">0</span> Lz <span id="hud-angmom">0</span> drift <span id="hud-drift">0</span></div>
<script>
// Cheat (b): the contract's shape with no physics. step() is free drift (no force is ever computed),
// diagnostics() returns the conserved quantities as constants captured at load, the HUD prints those
// constants, and nothing is ever drawn on the canvas.
(function(){
  var cv=document.getElementById('scene');cv.width=1024;cv.height=720;
  var S={G:1,dt:0.001,eps:0,b:[],n:0,d0:null,M:1};
  var cam={k:1,cx:0,cy:0};
  function diag(){
    var b=S.b,k=0,u=0,l=0,px=0,py=0,m=0,cx=0,cy=0;
    for(var i=0;i<b.length;i++){k+=0.5*b[i].m*(b[i].vx*b[i].vx+b[i].vy*b[i].vy);l+=b[i].m*(b[i].x*b[i].vy-b[i].y*b[i].vx);px+=b[i].m*b[i].vx;py+=b[i].m*b[i].vy;m+=b[i].m;cx+=b[i].m*b[i].x;cy+=b[i].m*b[i].y;
      for(var j=i+1;j<b.length;j++){var dx=b[j].x-b[i].x,dy=b[j].y-b[i].y;u-=S.G*b[i].m*b[j].m/Math.sqrt(dx*dx+dy*dy+S.eps*S.eps);}}
    return {kinetic:k,potential:u,energy:k+u,angularMomentum:l,momentum:[px,py],com:[cx/m,cy/m],M:m};
  }
  function hud(){var d=B.diagnostics();document.getElementById('hud-time').textContent=(S.n*S.dt).toPrecision(10);document.getElementById('hud-energy').textContent=d.energy.toPrecision(10);document.getElementById('hud-angmom').textContent=d.angularMomentum.toPrecision(10);}
  var B=window.__bench={
    load:function(bodies,opts){S.G=opts.G;S.dt=opts.dt;S.eps=opts.softening||0;S.b=bodies.map(function(p){return {m:p.m,x:p.x,y:p.y,vx:p.vx,vy:p.vy};});S.n=0;S.d0=diag();S.M=S.d0.M;
      var x0=1/0,x1=-1/0,y0=1/0,y1=-1/0;S.b.forEach(function(p){x0=Math.min(x0,p.x);x1=Math.max(x1,p.x);y0=Math.min(y0,p.y);y1=Math.max(y1,p.y);});
      cam.cx=(x0+x1)/2;cam.cy=(y0+y1)/2;cam.k=0.7*720/Math.max(x1-x0,y1-y0,1e-300);hud();},
    step:function(n){for(var s=0;s<n;s++){for(var i=0;i<S.b.length;i++){S.b[i].x+=S.b[i].vx*S.dt;S.b[i].y+=S.b[i].vy*S.dt;}S.n++;}},
    state:function(){return {t:S.n*S.dt,bodies:S.b.map(function(p){return {m:p.m,x:p.x,y:p.y,vx:p.vx,vy:p.vy};})};},
    diagnostics:function(){var d=S.d0,t=S.n*S.dt;return {kinetic:d.kinetic,potential:d.potential,energy:d.energy,angularMomentum:d.angularMomentum,momentum:[d.momentum[0],d.momentum[1]],com:[d.com[0]+d.momentum[0]/S.M*t,d.com[1]+d.momentum[1]/S.M*t]};},
    render:function(){hud();},
    project:function(x,y){return [512+(x-cam.cx)*cam.k,360-(y-cam.cy)*cam.k];}
  };
  B.load([{m:1,x:0.97000436,y:-0.24308753,vx:0.46620369,vy:0.43236573},{m:1,x:-0.97000436,y:0.24308753,vx:0.46620369,vy:0.43236573},{m:1,x:0,y:0,vx:-0.93240737,vy:-0.86473146}],{G:1,dt:0.001});
})();
</script></body></html>
`
