// VRM 角色加载器：把 .vrm 载入 three 场景，返回 VRM 实例。
// - autoUpdateHumanBones:true：每帧 vrm.update() 会把「归一化骨骼」的姿态写入真实骨骼，
//   因此我们只需驱动 humanoid 归一化骨骼即可摆出任意姿势（与具体模型的骨骼 roll 无关）。
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

let _loader;
function getLoader() {
  if (!_loader) {
    _loader = new GLTFLoader();
    _loader.register((parser) => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: true }));
  }
  return _loader;
}

// 载入并做标准优化；返回 { vrm }
export async function loadVrm(url) {
  const gltf = await getLoader().loadAsync(url);
  const vrm = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.combineMorphs(vrm);
  VRMUtils.rotateVRM0(vrm); // VRM1 为空操作；VRM0 旋转到面向 +Z
  gltf.scene.traverse((o) => { o.frustumCulled = false; });
  return vrm;
}
