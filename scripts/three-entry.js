// Only the rendering primitives used by the team hero; no controls, loaders,
// physics, editor helpers, or post-processing are shipped to the browser.
export {
  WebGLRenderer, Scene, OrthographicCamera, PlaneGeometry, Mesh,
  ShaderMaterial, BufferGeometry, BufferAttribute, Points,
  AdditiveBlending
} from 'three';
import * as primitives from 'three';

window.TokenHorizonThree = {
  WebGLRenderer: primitives.WebGLRenderer,
  Scene: primitives.Scene,
  OrthographicCamera: primitives.OrthographicCamera,
  PlaneGeometry: primitives.PlaneGeometry,
  Mesh: primitives.Mesh,
  ShaderMaterial: primitives.ShaderMaterial,
  BufferGeometry: primitives.BufferGeometry,
  BufferAttribute: primitives.BufferAttribute,
  Points: primitives.Points,
  AdditiveBlending: primitives.AdditiveBlending
};
