<script lang="ts">
	import { onMount } from 'svelte';
	import * as THREE from 'three';

	// Ambient Olympic-rings backdrop: five torus rings in the interlocked
	// formation, each tumbling on its own slowly-drifting axis behind the UI.
	// Pure atmosphere — pointer-transparent, low-power capped, static when
	// reduced-motion is requested, invisible when WebGL is unavailable (the
	// CSS gradient base remains). All tabbed screens share it via +layout.

	let canvas: HTMLCanvasElement | null = $state(null);

	/* Official palette on light; lifted luminous set on dark (the black
	   ring would vanish into a dark backdrop). */
	const LIGHT = [0x0081c8, 0xfcb131, 0x1c1c21, 0x00a651, 0xee334e];
	const DARK = [0x4aa3df, 0xf2c14e, 0xd8d8de, 0x37c978, 0xef6461];

	function isDark(): boolean {
		if (typeof document === 'undefined') return false;
		const t = document.documentElement.dataset.theme;
		if (t === 'light' || t === 'dark') return t === 'dark';
		return (
			typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
		);
	}

	onMount(() => {
		if (!canvas) return;
		// Backdrop must never take the app down with it: any failure hides
		// the canvas and leaves the CSS gradient base.
		try {
			return initBackdrop(canvas);
		} catch {
			canvas.style.display = 'none';
		}
	});

	function initBackdrop(canvas: HTMLCanvasElement) {
		let renderer: THREE.WebGLRenderer | null = null;
		try {
			renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
		} catch {
			canvas.style.display = 'none';
			return;
		}
		const reduce =
			typeof matchMedia !== 'undefined' &&
			matchMedia('(prefers-reduced-motion: reduce)').matches;

		renderer.setClearColor(0x000000, 0);
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
		camera.position.set(0, 0, 13);

		scene.add(new THREE.AmbientLight(0xffffff, 0.85));
		const key = new THREE.DirectionalLight(0xffffff, 1.6);
		key.position.set(4, 6, 8);
		scene.add(key);
		const rim = new THREE.PointLight(0x88aaff, 12, 40);
		rim.position.set(-6, -3, 4);
		scene.add(rim);

		const group = new THREE.Group();
		scene.add(group);

		// Interlocked formation: blue black red over yellow green, alternating
		// z offsets so neighbours weave over/under.
		const formation: { x: number; y: number; z: number }[] = [
			{ x: -2.5, y: 1.25, z: 0.18 },
			{ x: 0, y: 1.25, z: -0.18 },
			{ x: 2.5, y: 1.25, z: 0.18 },
			{ x: -1.25, y: -1.05, z: -0.18 },
			{ x: 1.25, y: -1.05, z: 0.18 }
		];
		const geo = new THREE.TorusGeometry(1.55, 0.24, 28, 110);
		const mats: THREE.MeshStandardMaterial[] = [];
		const rings: THREE.Mesh[] = [];
		const axes: THREE.Vector3[] = [];
		const targets: THREE.Vector3[] = [];
		const speeds: number[] = [];

		const randomAxis = () =>
			new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();

		const applyPalette = (dark: boolean) => {
			const cols = dark ? DARK : LIGHT;
			for (let i = 0; i < mats.length; i++) {
				mats[i].color.setHex(cols[i]);
				mats[i].emissive.setHex(cols[i]);
			}
		};

		for (let i = 0; i < 5; i++) {
			const mat = new THREE.MeshStandardMaterial({
				color: 0xffffff,
				roughness: 0.3,
				metalness: 0.55,
				emissive: 0xffffff,
				emissiveIntensity: 0.22
			});
			mats.push(mat);
			const ring = new THREE.Mesh(geo, mat);
			ring.position.set(formation[i].x, formation[i].y, formation[i].z);
			ring.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
			group.add(ring);
			rings.push(ring);
			axes.push(randomAxis());
			targets.push(randomAxis());
			speeds.push(0.06 + Math.random() * 0.1);
		}
		applyPalette(isDark());

		const themeObserver = new MutationObserver(() => applyPalette(isDark()));
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme']
		});
		const mq = matchMedia('(prefers-color-scheme: dark)');
		const onScheme = () => applyPalette(isDark());
		mq.addEventListener?.('change', onScheme);

		let fitScale = 1;
		// Scroll parallax state — declared before layout() runs, which reads
		// it via readScroll() on the first call.
		let targetP = 0;
		let curP = 0;
		function readScroll() {
			const max = document.documentElement.scrollHeight - window.innerHeight;
			targetP = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
		}
		function layout() {
			if (!canvas || !renderer) return;
			const w = window.innerWidth;
			const h = window.innerHeight;
			renderer.setSize(w, h, false);
			camera.aspect = w / Math.max(1, h);
			camera.updateProjectionMatrix();
			// Drift right on wide windows so the cluster peeks around the
			// centered content column instead of hiding fully behind it.
			group.position.x = w > h * 1.2 ? 2.2 : 0;
			fitScale = Math.min(1.15, Math.max(0.62, Math.min(w, h) / 760));
			readScroll();
		}
		layout();
		window.addEventListener('resize', layout);

		// Scroll parallax: 0 at top, 1 at bottom. Tab switches change the
		// page height under us — the render value chases the target with
		// damping so the dive stays smooth through the jump.
		window.addEventListener('scroll', readScroll, { passive: true });
	

		let raf = 0;
		let last = performance.now();
		let retarget = 0;
		const tmp = new THREE.Quaternion();

		function frame(now: number) {
			raf = requestAnimationFrame(frame);
			if (document.hidden) {
				last = now;
				return;
			}
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			// Damped chase — tab switches resize the page (new scroll range)
			// and the rings glide instead of snapping.
			curP += (targetP - curP) * (1 - Math.exp(-dt * 2.5));
			// Every few seconds one random ring picks a new tumble axis.
			retarget += dt;
			if (retarget > 9) {
				retarget = 0;
				targets[Math.floor(Math.random() * targets.length)].copy(randomAxis());
			}
			const t = now / 1000;
			for (let i = 0; i < rings.length; i++) {
				axes[i].lerp(targets[i], 1 - Math.exp(-dt * 0.25)).normalize();
				tmp.setFromAxisAngle(axes[i], speeds[i] * dt);
				rings[i].quaternion.premultiply(tmp);
			}
			group.position.y = Math.sin(t * 0.18) * 0.28 - curP * 2.4;
			group.rotation.y = Math.sin(t * 0.11) * 0.1;
			// Dive: zoom in as the page descends, breathing over it.
			const breathe = 1 + Math.sin(t * 0.14) * 0.025;
			group.scale.setScalar(fitScale * (1 + curP * 0.38) * breathe);
			renderer?.render(scene, camera);
		}

		if (reduce) {
			group.scale.setScalar(fitScale);
			renderer.render(scene, camera);
		} else {
			raf = requestAnimationFrame(frame);
		}

		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', layout);
			window.removeEventListener('scroll', readScroll);
			themeObserver.disconnect();
			mq.removeEventListener?.('change', onScheme);
			geo.dispose();
			for (const m of mats) m.dispose();
			renderer?.dispose();
		};
	}
</script>

<canvas bind:this={canvas} class="rings-bg" aria-hidden="true"></canvas>
<div class="rings-veil" aria-hidden="true"></div>

<style>
	.rings-bg {
		position: fixed;
		inset: 0;
		width: 100%;
		height: 100%;
		z-index: -1;
		pointer-events: none;
	}
	/* Frosted scrim over the solid rings: white tint in light mode,
	   black tint in dark — the rings melt into soft color fields and
	   every translucent surface below plays with their light. */
	.rings-veil {
		position: fixed;
		inset: 0;
		z-index: -1;
		pointer-events: none;
		background: light-dark(rgb(255 255 255 / 0.78), rgb(0 0 0 / 0.78));
		backdrop-filter: blur(110px) saturate(1.15);
		-webkit-backdrop-filter: blur(110px) saturate(1.15);
	}
	@media (prefers-reduced-motion: reduce) {
		.rings-veil {
			backdrop-filter: blur(110px);
			-webkit-backdrop-filter: blur(110px);
		}
	}
</style>
