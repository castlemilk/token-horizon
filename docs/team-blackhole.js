/* A bounded, self-hosted Three.js scene. Public team data and authentication
   never depend on this decorative enhancement becoming ready. */
(() => {
  "use strict";
  const VERSION = "20261001-team-1";
  const scriptSource = document.currentScript?.src || new URL("/team-blackhole.js", location.href).href;
  const assetRoot = new URL("./", scriptSource);
  const instances = new WeakMap();
  let threePromise;
  const PROVIDERS = [
    { key: "openai", name: "OpenAI", file: "openai.svg", bg: "#171717", color: [0.60, 0.83, 0.70] },
    { key: "anthropic", name: "Anthropic", file: "anthropic.svg", bg: "#d97757", color: [0.94, 0.61, 0.43] },
    { key: "google", name: "Google", file: "google.png", bg: "#ffffff", color: [0.48, 0.66, 0.98] },
    { key: "deepseek", name: "DeepSeek", file: "deepseek.svg", bg: "#1585eb", color: [0.39, 0.63, 0.96] },
    { key: "mistral", name: "Mistral", file: "mistral.svg", bg: "#f2660d", color: [0.96, 0.67, 0.31] },
    { key: "qwen", name: "Qwen", file: "qwen.svg", bg: "#6950ef", color: [0.68, 0.59, 0.94] }
  ];

  function loadThree() {
    if (window.TokenHorizonThree) return Promise.resolve(window.TokenHorizonThree);
    if (threePromise) return threePromise;
    threePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("vendor/three.js?v=" + VERSION, assetRoot).href;
      script.async = true;
      const timer = setTimeout(() => fail(), 8000);
      function fail() {
        clearTimeout(timer);
        script.remove();
        reject(new Error("Team scene runtime unavailable"));
      }
      script.onload = () => {
        clearTimeout(timer);
        if (window.TokenHorizonThree) resolve(window.TokenHorizonThree);
        else fail();
      };
      script.onerror = fail;
      document.head.appendChild(script);
    }).catch(error => { threePromise = null; throw error; });
    return threePromise;
  }

  const holeVertex = `varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
  const holeFragment = `
    precision highp float;
    varying vec2 vUv;
    uniform vec2 uResolution;
    uniform float uTime;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);
    }
    void main() {
      vec2 p = (vUv - .5) * 2.; p.x *= uResolution.x/uResolution.y;
      float r = length(p);
      vec3 bg = vec3(.035, .066, .054);
      float veil = exp(-r*r*.8) * .016;
      vec3 color = bg + vec3(.20,.34,.25)*veil;
      // A pitched, sheared accretion plane with orbiting filaments.
      vec2 disk = vec2(p.x, (p.y + p.x*.115) / .31);
      float dr = length(disk), theta = atan(disk.y, disk.x);
      float thread = noise(vec2(theta * 11. - uTime*.4, dr * 65.));
      float fine = .62 + .38*sin(dr * 174. + thread*6. + theta*3. - uTime*.28);
      float band = exp(-pow((dr-.90)/.17, 2.)) * fine;
      float sharp = exp(-pow((dr-.77)/.022, 2.));
      float dust = exp(-pow((dr-1.02)/.34, 2.)) * pow(thread, 3.) * .13;
      float beaming = .56 + .44*smoothstep(-1.0, 1.0, -disk.x);
      vec3 mint = mix(vec3(.34,.54,.42), vec3(.87,.95,.81), sharp);
      color += mint*(band*.86 + sharp*.60 + dust)*beaming;
      // The back of the disk bends into a lens above the photon sphere.
      vec2 lens = vec2(p.x, p.y-.018);
      float lr = length(lens);
      float lensArc = exp(-pow((lr-.452)/.025, 2.)) * smoothstep(-.04,.14,p.y);
      float lensThread = .60+.40*noise(vec2(atan(lens.y,lens.x)*35.-uTime*.17,lr*128.));
      color += vec3(.78,.90,.74)*lensArc*lensThread*.76;
      float outerDust = exp(-pow((r-.64)/.18,2.)) * noise(p*11.+uTime*.018)*.018;
      color += vec3(.38,.60,.43)*outerDust;
      // A hard event horizon: no transparent hole or glowing pseudo-planet.
      float occlusion = 1.-smoothstep(.415,.424,r);
      color = mix(color, vec3(.010,.021,.016), occlusion);
      float edge = exp(-pow((r-.425)/.007,2.));
      color += vec3(.91,.98,.85)*edge*.72;
      color += vec3(.38,.63,.44)*exp(-pow((r-.435)/.017,2.))*.12;
      // The thin foreground filament crosses below the lens, giving depth.
      float front = smoothstep(.045,-.018,p.y+p.x*.115);
      color += vec3(.70,.88,.70)*(band*.20+sharp*.22)*front*(1.-occlusion);
      float vignette = smoothstep(1.8,.42,r);
      color = mix(bg*.80, color, .64+.36*vignette);
      gl_FragColor = vec4(color,1.);
    }`;
  const tokenVertex = `
    attribute float aPhase; attribute float aAngle; attribute float aSpeed;
    attribute vec3 aColor;
    uniform float uTime; uniform float uAspect; uniform float uDpr;
    varying vec3 vColor; varying float vAlpha;
    void main() {
      float phase = fract(aPhase+uTime*aSpeed);
      float radius = .46+pow(1.-phase,1.3)*1.62;
      float angle = aAngle+phase*phase*5.4;
      vec2 p = vec2(cos(angle)*radius,sin(angle)*radius*.68);
      p.y -= p.x*.075;
      gl_Position = vec4(p.x/uAspect,p.y,0.,1.);
      gl_PointSize = (1.4+1.8*phase)*uDpr;
      vColor = mix(aColor,vec3(.87,.96,.81),phase);
      vAlpha = smoothstep(0.,.13,phase)*(1.-smoothstep(.76,.99,phase))*.8;
    }`;
  const tokenFragment = `
    varying vec3 vColor; varying float vAlpha;
    void main() {
      float d=length(gl_PointCoord-.5);
      float a=(1.-smoothstep(.10,.50,d))*vAlpha;
      if(a<.015) discard;
      gl_FragColor=vec4(vColor,a);
    }`;

  function mount(host) {
    if (!host || !host.isConnected) return { destroy() {}, pause() {}, resume() {} };
    if (instances.has(host)) return instances.get(host);
    let destroyed = false, visible = false, userPaused = false, loading = false;
    let raf = 0, lastFrame = 0, previous = 0, elapsed = 0, frames = 0;
    let renderer, scene, camera, hole, tokens, canvas;
    let width = 1, height = 1, dpr = 1, logosAnchored = false;
    const geometries = [], materials = [];
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    host.dataset.motionState = "static";
    const fallback = document.createElement("div");
    fallback.className = "th-team-hole-fallback";
    const providerLayer = document.createElement("div");
    providerLayer.className = "th-team-hole-providers";
    const providerNodes = PROVIDERS.map(provider => {
      const tile = document.createElement("span");
      tile.className = "th-team-hole-provider";
      tile.dataset.provider = provider.key;
      tile.style.setProperty("--provider-bg", provider.bg);
      const img = document.createElement("img");
      img.src = new URL("assets/brands/" + provider.file + "?v=20261001", assetRoot).href;
      img.alt = ""; img.width = 32; img.height = 32; img.decoding = "async";
      tile.title = provider.name;
      img.onerror = () => { img.remove(); tile.textContent = provider.name.slice(0,2); };
      tile.appendChild(img); providerLayer.appendChild(tile);
      return tile;
    });
    const glyphs = Array.from({ length: 10 }, (_, i) => {
      const glyph = document.createElement("span");
      glyph.className = "th-team-hole-token";
      glyph.textContent = ["[tok]", "{ }", "···", "< >", "[ ]"][i % 5];
      providerLayer.appendChild(glyph);
      return glyph;
    });
    const edge = document.createElement("div"); edge.className = "th-team-hole-edge";
    host.append(fallback, providerLayer, edge);

    function renderLogos(time) {
      if (!logosAnchored) {
        [...providerNodes, ...glyphs].forEach(node => { node.style.left = "50%"; node.style.top = "50%"; });
        logosAnchored = true;
      }
      const aspect = width/height;
      providerNodes.forEach((node, i) => {
        const phase = (i/PROVIDERS.length + time*.036) % 1;
        const radius = .47 + Math.pow(1-phase, .8)*1.09;
        const angle = i*2.39996 + phase*phase*4.3;
        // Keep each recognisable mark inside the composition on narrow screens.
        const x = Math.cos(angle)*radius*Math.min(1,aspect*.86/1.56);
        const y = (Math.sin(angle)*radius*.77-x*.075)*.66;
        const scale = .90 - phase*.64;
        // Preserve the rounded orbit coordinates without changing layout each frame.
        const offsetX = (Number(((.5 + x/aspect*.5)*100).toFixed(3))-50)*width/100;
        const offsetY = (Number(((.5 - y*.5)*100).toFixed(3))-50)*height/100;
        node.style.transform = `translate3d(${offsetX}px,${offsetY}px,0) translate(-50%,-50%) rotate(${(Math.sin(angle)*12+phase*24).toFixed(2)}deg) scale(${scale.toFixed(3)})`;
        const horizonFade = Math.max(0,Math.min(1,(Math.hypot(x,y)-.42)/.20));
        node.style.opacity = String(Math.min(.95, (1-Math.max(0,phase-.7)/.3)*.95)*horizonFade);
      });
      glyphs.forEach((node,i) => {
        const phase = (i/glyphs.length+time*.068)%1;
        const radius = .46+Math.pow(1-phase,1.2)*1.52;
        const angle = i*2.39996+phase*phase*5.4;
        const x = Math.cos(angle)*radius, y = Math.sin(angle)*radius*.70-x*.075;
        const offsetX = (Number(((.5+x/aspect*.5)*100).toFixed(3))-50)*width/100;
        const offsetY = (Number(((.5-y*.5)*100).toFixed(3))-50)*height/100;
        node.style.opacity = String(Math.min(.60, phase*4, (1-phase)*4));
        node.style.transform = `translate3d(${offsetX}px,${offsetY}px,0) translate(-50%,-50%) rotate(${(-angle*9).toFixed(2)}deg)`;
      });
    }
    function resize() {
      const rect = host.getBoundingClientRect();
      width = Math.max(1,rect.width); height = Math.max(1,rect.height);
      dpr = Math.min(devicePixelRatio || 1,1.5);
      if (renderer) {
        renderer.setPixelRatio(dpr); renderer.setSize(width,height,false);
        hole.material.uniforms.uResolution.value = [width,height];
        tokens.material.uniforms.uAspect.value = width/height;
        tokens.material.uniforms.uDpr.value = dpr;
        renderer.render(scene,camera);
      }
      if (renderer && !reduced.matches) renderLogos(elapsed);
    }
    function canRun() { return !destroyed && visible && !document.hidden && !userPaused && !reduced.matches && Boolean(renderer); }
    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0; previous = 0; lastFrame = 0;
      host.dataset.motionState = reduced.matches || !renderer ? "static" : "paused";
      if (reduced.matches) {
        providerNodes.forEach(node => { node.removeAttribute("style"); node.style.setProperty("--provider-bg",PROVIDERS[providerNodes.indexOf(node)].bg); });
        glyphs.forEach(node => { node.style.opacity="0"; });
        logosAnchored = false;
      }
    }
    function frame(stamp) {
      raf = 0;
      if (!canRun()) { stop(); return; }
      // Bounded 30fps desktop / 24fps mobile, with no catch-up work after pause.
      const budget = width < 600 ? 1000/24 : 1000/30;
      if (!lastFrame || stamp-lastFrame >= budget-1) {
        if (previous) elapsed += Math.min(.08,(stamp-previous)/1000);
        previous=stamp; lastFrame=stamp;
        hole.material.uniforms.uTime.value=elapsed;
        tokens.material.uniforms.uTime.value=elapsed;
        renderLogos(elapsed);
        renderer.render(scene,camera); frames++;
      }
      raf=requestAnimationFrame(frame);
    }
    function reconcile() {
      if (destroyed) return;
      if (!host.isConnected) { destroy(); return; }
      if (visible && !document.hidden && !reduced.matches && !userPaused && !renderer && !loading) initialise();
      if (canRun()) {
        host.dataset.motionState="running";
        if (!raf) raf=requestAnimationFrame(frame);
      } else stop();
    }
    async function initialise() {
      loading=true;
      try {
        const T=await loadThree();
        if (destroyed || reduced.matches || !host.isConnected) return;
        canvas=document.createElement("canvas"); canvas.setAttribute("aria-hidden","true");
        const context=canvas.getContext("webgl2",{alpha:false,antialias:false,powerPreference:"low-power"});
        if (!context) { host.dataset.motionState="fallback"; return; }
        renderer=new T.WebGLRenderer({canvas,context,antialias:false,alpha:false,powerPreference:"low-power"});
        renderer.setClearColor(0x09110f,1);
        scene=new T.Scene(); camera=new T.OrthographicCamera(-1,1,1,-1,0,2); camera.position.z=1;
        const diskGeometry=new T.PlaneGeometry(2,2);
        const diskMaterial=new T.ShaderMaterial({vertexShader:holeVertex,fragmentShader:holeFragment,uniforms:{uTime:{value:0},uResolution:{value:[width,height]}},depthTest:false,depthWrite:false,toneMapped:false});
        geometries.push(diskGeometry); materials.push(diskMaterial);
        hole=new T.Mesh(diskGeometry,diskMaterial); scene.add(hole);
        const count=host.getBoundingClientRect().width<600 ? 210 : 420;
        const geometry=new T.BufferGeometry();
        const position=new Float32Array(count*3), phase=new Float32Array(count),angle=new Float32Array(count),speed=new Float32Array(count),colors=new Float32Array(count*3);
        for(let i=0;i<count;i++) {
          phase[i]=(i*.61803398875)%1;
          angle[i]=(i%PROVIDERS.length)*Math.PI*2/PROVIDERS.length+Math.sin(i*7.131)*.13;
          speed[i]=.042+(i%7)*.002; colors.set(PROVIDERS[i%PROVIDERS.length].color,i*3);
        }
        geometry.setAttribute("position",new T.BufferAttribute(position,3));
        geometry.setAttribute("aPhase",new T.BufferAttribute(phase,1));
        geometry.setAttribute("aAngle",new T.BufferAttribute(angle,1));
        geometry.setAttribute("aSpeed",new T.BufferAttribute(speed,1));
        geometry.setAttribute("aColor",new T.BufferAttribute(colors,3));
        const material=new T.ShaderMaterial({vertexShader:tokenVertex,fragmentShader:tokenFragment,uniforms:{uTime:{value:0},uAspect:{value:width/height},uDpr:{value:dpr}},transparent:true,blending:T.AdditiveBlending,depthTest:false,depthWrite:false,toneMapped:false});
        geometries.push(geometry); materials.push(material);
        tokens=new T.Points(geometry,material); tokens.frustumCulled=false; tokens.renderOrder=1; scene.add(tokens);
        canvas.addEventListener("webglcontextlost",contextLost);
        host.insertBefore(canvas,providerLayer);
        resize(); reconcile();
      } catch (_) { host.dataset.motionState="fallback"; releaseRenderer(); }
      finally { loading=false; }
    }
    function contextLost(event) {
      event.preventDefault(); stop(); releaseRenderer();
      userPaused=true; host.dataset.motionState="fallback";
      providerNodes.forEach(node => { node.removeAttribute("style"); node.style.setProperty("--provider-bg",PROVIDERS[providerNodes.indexOf(node)].bg); });
      glyphs.forEach(node => { node.style.opacity="0"; });
      logosAnchored = false;
    }
    function releaseRenderer() {
      geometries.splice(0).forEach(resource=>resource.dispose());
      materials.splice(0).forEach(resource=>resource.dispose());
      canvas?.removeEventListener("webglcontextlost",contextLost);
      if(renderer) { renderer.dispose(); renderer.forceContextLoss(); }
      renderer=null; canvas?.remove(); canvas=null;
    }
    const resizeObserver=typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    resizeObserver?.observe(host);
    const observer=typeof IntersectionObserver === "function" ? new IntersectionObserver(entries=>{
      visible=entries.some(entry=>entry.isIntersecting); reconcile();
    },{threshold:.03}) : null;
    observer?.observe(host);
    const detachObserver=new MutationObserver(()=>{if(!host.isConnected) destroy();});
    detachObserver.observe(document.body,{childList:true,subtree:true});
    document.addEventListener("visibilitychange",reconcile);
    reduced.addEventListener("change",reconcile);
    if(!resizeObserver) window.addEventListener("resize",resize);
    resize();
    if(!observer) { visible=true; reconcile(); }
    function destroy() {
      if(destroyed) return;
      destroyed=true; stop(); observer?.disconnect(); resizeObserver?.disconnect(); detachObserver.disconnect();
      document.removeEventListener("visibilitychange",reconcile); reduced.removeEventListener("change",reconcile);
      window.removeEventListener("resize",resize);
      releaseRenderer(); fallback.remove(); providerLayer.remove(); edge.remove();
      instances.delete(host); host.dataset.motionState="destroyed";
    }
    const api={destroy,pause(){userPaused=true;reconcile();},resume(){userPaused=false;reconcile();},get state(){return host.dataset.motionState;},get frameCount(){return frames;}};
    instances.set(host,api);
    return api;
  }
  window.TokenHorizonTeamMotion={mount,version:VERSION};
})();
