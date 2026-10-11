// 职责：校园公告栏（世界坐标 -22,17 的那块板子）。
// 一块带 canvas 贴图的木牌 + 两根柱子；玩家刊登的公告会实时画到板面上。
// 与服务端 BOARD_POS（server-remote/npcworld.js）坐标保持一致。
import * as THREE from 'three';

const POST_W = 3.0;   // 板面宽（米）
const POST_H = 1.7;   // 板面高
const POST_Y = 1.9;   // 板面中心离地高
const MAX_LINES = 6;  // 板面上最多显示几条

function makeBoardTexture() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 288;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { cv, tex };
}

function drawBoard(cv, posts) {
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#6b4a2b'; // 木框
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#e9dcbf'; // 纸面
  g.fillRect(14, 14, cv.width - 28, cv.height - 28);
  g.fillStyle = '#7a5a33';
  g.font = 'bold 26px "Microsoft YaHei", "PingFang SC", sans-serif';
  g.textAlign = 'center';
  g.fillText('公 告 栏', cv.width / 2, 48);
  g.textAlign = 'left';
  g.font = '20px "Microsoft YaHei", "PingFang SC", sans-serif';
  g.fillStyle = '#2b2b2b';
  const list = (posts || []).slice(-MAX_LINES);
  if (!list.length) {
    g.fillStyle = '#8a8a8a';
    g.fillText('（还没有公告，来贴一张吧）', 34, 90);
  } else {
    let y = 84;
    for (const p of list) {
      const t = String(p && p.text ? p.text : p || '').slice(0, 22);
      g.fillStyle = '#2b2b2b';
      g.fillText('· ' + t, 34, y);
      y += 30;
      if (y > cv.height - 16) break;
    }
  }
}

export function createBulletinBoard(scene, pos) {
  const p = pos || { x: -22, z: 17 };
  const group = new THREE.Group();
  group.name = 'bulletin-board';
  group.position.set(p.x, 0, p.z);

  const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.9 });
  // 两根柱子
  for (const dx of [-POST_W / 2 + 0.15, POST_W / 2 - 0.15]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, POST_Y + POST_H / 2, 0.16), woodMat);
    leg.position.set(dx, (POST_Y + POST_H / 2) / 2, 0);
    leg.castShadow = true;
    group.add(leg);
  }
  // 板面（canvas 贴图）
  const { cv, tex } = makeBoardTexture();
  drawBoard(cv, []);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(POST_W, POST_H), new THREE.MeshBasicMaterial({ map: tex }));
  board.position.set(0, POST_Y, 0.08);
  group.add(board);
  // 背板（让牌子有厚度）
  const back = new THREE.Mesh(new THREE.BoxGeometry(POST_W + 0.1, POST_H + 0.1, 0.08), woodMat);
  back.position.set(0, POST_Y, 0);
  back.castShadow = true;
  group.add(back);

  scene.add(group);

  function setPosts(list) { drawBoard(cv, list); tex.needsUpdate = true; }
  function dispose() {
    if (group.parent) group.parent.remove(group);
    group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    tex.dispose();
  }
  return { group, setPosts, dispose, pos: { x: p.x, z: p.z } };
}
