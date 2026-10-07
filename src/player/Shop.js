// 职责：学币钱包与商店商品表。
// 学币和「已购买」清单都写在 localStorage 里、按账号隔离：同一个账号在任意客户端打开读到的
// 都是同一份（这就是「一个账户互联」）；游客用独立的 guest 键，不与任何账号混用。
import { Config } from '../config.js';
import { getBagKey, loadBag, addToBag, removeFromBag } from './Inventory.js';
import { markSaveDirty } from './CloudSave.js';
import { accountApi } from '../net/accountApi.js';

const KEY_PREFIX = 'fp_wallet__';

// 商店在售商品。effect 会写进物品效果表（与阿花给的东西同一套），
// 所以买到手之后进背包、指定到技能槽，按数字键就能用。
export const SHOP_ITEMS = [
  {
    id: 'club',
    name: '棍子',
    price: 100,
    desc: '挥动横扫，被扫到的玩家会被撞飞出去。',
    effect: { k: 'club' },
  },
  {
    id: 'blackhole',
    name: '黑洞',
    price: 150,
    desc: '扔出去后会不断变大，10 秒后把范围内的人吸过去。',
    effect: { k: 'blackhole' },
  },
  {
    id: 'hide',
    name: '捉迷藏玩具',
    price: 80,
    desc: '变成任意颜色的方块。开始前先选和谁玩、谁抓；每 30 秒向抓的人报告自己的模糊方向。',
    effect: { k: 'hide' },
  },
  {
    id: 'gatling',
    name: '加特林',
    price: 200,
    desc: '按技能槽开火模式后，按住鼠标左键持续扫射。单发 5 点伤害，打久了会过热。',
    effect: { k: 'gatling' },
  },
  {
    id: 'ctrlgun',
    name: '控制枪',
    price: 180,
    desc: '发射激光抓住别人，移动视角就能把他拖着走；对方可以按空格挣脱。',
    effect: { k: 'control' },
  },
  {
    id: 'grapple',
    name: '抓钩',
    price: 160,
    desc: '朝准星方向甩出钩爪，勾到墙/箱/柱子就把自己拽过去；空中再按一次即可松手。',
    effect: { k: 'grapple' },
  },
  {
    id: 'hammer',
    name: '建造锤',
    price: 300,
    desc: '装备到技能槽，按对应数字键（手机点技能键）进入建造模式：攻击键变「放置」，血条变可滚动家具条，另有「编辑」键。',
    effect: { k: 'hammer' },
  },
  {
    id: 'invitetp',
    name: '邀请传送',
    price: 200,
    desc: '装备到技能槽后按对应键，会弹出在线玩家列表；选一个人发出邀请，他同意后就会传送到你身边。',
    effect: { k: 'invitetp' },
  },
  // ---- 家具（可摆放）· Kenney Furniture Kit 2.0（CC0）----
  // url 先留 placeholder（占位方块）；服务端启动时会自动把 url 对位到已上传的同名资源
  // （按「以 <id>.glb 结尾」在 assets 目录里找），所以上传完重启一次即可显示真模型。
  // 价格一律 ≤100（用户要求）。
    { id: 'furn_bathroom_cabinet', name: '浴室柜', url: 'placeholder', price: 65, desc: '浴室柜（卫浴）。模型原尺寸 0.23×0.39×0.13 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.46, 0.78, 0.26] },
    { id: 'furn_bathroom_cabinet_drawer', name: '浴室抽屉柜', url: 'placeholder', price: 65, desc: '浴室抽屉柜（卫浴）。模型原尺寸 0.43×0.47×0.32 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.94, 0.64] },
    { id: 'furn_bathroom_mirror', name: '浴室镜', url: 'placeholder', price: 65, desc: '浴室镜（卫浴）。模型原尺寸 0.30×0.43×0.14 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.6, 0.87, 0.29] },
    { id: 'furn_bathroom_sink', name: '洗手池', url: 'placeholder', price: 80, desc: '洗手池（卫浴）。模型原尺寸 0.34×0.56×0.29 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.68, 1.12, 0.58] },
    { id: 'furn_bathroom_sink_square', name: '方形洗手池', url: 'placeholder', price: 80, desc: '方形洗手池（卫浴）。模型原尺寸 0.43×0.58×0.30 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 1.16, 0.6] },
    { id: 'furn_bathtub', name: '浴缸', url: 'placeholder', price: 95, desc: '浴缸（卫浴）。模型原尺寸 1.19×0.42×0.56 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [2.38, 0.84, 1.12] },
    { id: 'furn_bear', name: '玩具熊', url: 'placeholder', price: 22, desc: '玩具熊（绿植/软装）。模型原尺寸 0.39×0.45×0.25 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.78, 0.9, 0.49] },
    { id: 'furn_bed_bunk', name: '双层床', url: 'placeholder', price: 100, desc: '双层床（卧室）。模型原尺寸 0.57×0.85×1.09 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.14, 1.7, 2.19] },
    { id: 'furn_bed_double', name: '双人床', url: 'placeholder', price: 100, desc: '双人床（卧室）。模型原尺寸 0.96×0.38×1.12 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.91, 0.75, 2.25] },
    { id: 'furn_bed_single', name: '单人床', url: 'placeholder', price: 100, desc: '单人床（卧室）。模型原尺寸 0.57×0.38×1.12 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.14, 0.75, 2.25] },
    { id: 'furn_bench', name: '长凳', url: 'placeholder', price: 40, desc: '长凳（坐具/沙发）。模型原尺寸 0.40×0.47×0.20 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 0.94, 0.4] },
    { id: 'furn_bench_cushion', name: '软垫长凳', url: 'placeholder', price: 40, desc: '软垫长凳（坐具/沙发）。模型原尺寸 0.40×0.46×0.20 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 0.92, 0.4] },
    { id: 'furn_bench_cushion_low', name: '矮软垫长凳', url: 'placeholder', price: 40, desc: '矮软垫长凳（坐具/沙发）。模型原尺寸 0.42×0.20×0.22 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.84, 0.4, 0.44] },
    { id: 'furn_bookcase_closed', name: '封闭书架', url: 'placeholder', price: 70, desc: '封闭书架（柜架/收纳）。模型原尺寸 0.40×0.85×0.25 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 1.7, 0.5] },
    { id: 'furn_bookcase_closed_doors', name: '带门书架', url: 'placeholder', price: 70, desc: '带门书架（柜架/收纳）。模型原尺寸 0.40×0.85×0.25 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 1.7, 0.5] },
    { id: 'furn_bookcase_closed_wide', name: '宽封闭书架', url: 'placeholder', price: 70, desc: '宽封闭书架（柜架/收纳）。模型原尺寸 0.80×0.79×0.25 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.6, 1.58, 0.5] },
    { id: 'furn_bookcase_open', name: '开放书架', url: 'placeholder', price: 70, desc: '开放书架（柜架/收纳）。模型原尺寸 0.40×0.88×0.25 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 1.76, 0.5] },
    { id: 'furn_bookcase_open_low', name: '矮开放书架', url: 'placeholder', price: 55, desc: '矮开放书架（柜架/收纳）。模型原尺寸 0.40×0.40×0.25 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 0.8, 0.5] },
    { id: 'furn_books', name: '一摞书', url: 'placeholder', price: 55, desc: '一摞书（柜架/收纳）。模型原尺寸 0.15×0.10×0.10 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.3, 0.21, 0.19] },
    { id: 'furn_cabinet_bed', name: '床柜', url: 'placeholder', price: 75, desc: '床柜（卧室）。模型原尺寸 0.27×0.23×0.21 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.53, 0.47, 0.43] },
    { id: 'furn_cabinet_bed_drawer', name: '床柜(带抽屉)', url: 'placeholder', price: 75, desc: '床柜(带抽屉)（卧室）。模型原尺寸 0.27×0.26×0.22 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.53, 0.53, 0.43] },
    { id: 'furn_cabinet_bed_drawer_table', name: '床柜桌', url: 'placeholder', price: 75, desc: '床柜桌（卧室）。模型原尺寸 0.27×0.26×0.22 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.53, 0.53, 0.43] },
    { id: 'furn_cabinet_television', name: '电视柜', url: 'placeholder', price: 70, desc: '电视柜（柜架/收纳）。模型原尺寸 0.80×0.31×0.25 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.6, 0.62, 0.5] },
    { id: 'furn_cabinet_television_doors', name: '带门电视柜', url: 'placeholder', price: 70, desc: '带门电视柜（柜架/收纳）。模型原尺寸 0.80×0.31×0.26 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.6, 0.62, 0.52] },
    { id: 'furn_cardboard_box_closed', name: '纸箱(封)', url: 'placeholder', price: 55, desc: '纸箱(封)（柜架/收纳）。模型原尺寸 0.21×0.28×0.21 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.42, 0.56, 0.42] },
    { id: 'furn_cardboard_box_open', name: '纸箱(开)', url: 'placeholder', price: 55, desc: '纸箱(开)（柜架/收纳）。模型原尺寸 0.37×0.28×0.21 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.74, 0.56, 0.42] },
    { id: 'furn_ceiling_fan', name: '吊扇', url: 'placeholder', price: 45, desc: '吊扇（照明）。模型原尺寸 0.46×0.13×0.53 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.91, 0.27, 1.05] },
    { id: 'furn_chair', name: '木椅', url: 'placeholder', price: 40, desc: '木椅（坐具/沙发）。模型原尺寸 0.20×0.47×0.20 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.4, 0.94, 0.4] },
    { id: 'furn_chair_cushion', name: '软垫椅', url: 'placeholder', price: 40, desc: '软垫椅（坐具/沙发）。模型原尺寸 0.20×0.46×0.20 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.4, 0.92, 0.4] },
    { id: 'furn_chair_desk', name: '办公椅', url: 'placeholder', price: 55, desc: '办公椅（坐具/沙发）。模型原尺寸 0.34×0.61×0.31 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.67, 1.22, 0.63] },
    { id: 'furn_chair_modern_cushion', name: '现代软垫椅', url: 'placeholder', price: 40, desc: '现代软垫椅（坐具/沙发）。模型原尺寸 0.20×0.46×0.20 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.4, 0.92, 0.4] },
    { id: 'furn_chair_modern_frame_cushion', name: '现代框软垫椅', url: 'placeholder', price: 40, desc: '现代框软垫椅（坐具/沙发）。模型原尺寸 0.20×0.46×0.20 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.4, 0.92, 0.4] },
    { id: 'furn_chair_rounded', name: '圆角椅', url: 'placeholder', price: 40, desc: '圆角椅（坐具/沙发）。模型原尺寸 0.20×0.46×0.20 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.4, 0.91, 0.4] },
    { id: 'furn_coat_rack', name: '挂衣架', url: 'placeholder', price: 55, desc: '挂衣架（柜架/收纳）。模型原尺寸 0.45×0.28×0.13 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.9, 0.56, 0.27] },
    { id: 'furn_coat_rack_standing', name: '落地衣帽架', url: 'placeholder', price: 70, desc: '落地衣帽架（柜架/收纳）。模型原尺寸 0.27×0.77×0.27 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.55, 1.54, 0.55] },
    { id: 'furn_computer_keyboard', name: '键盘', url: 'placeholder', price: 40, desc: '键盘（电子）。模型原尺寸 0.28×0.03×0.12 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.56, 0.06, 0.24] },
    { id: 'furn_computer_mouse', name: '鼠标', url: 'placeholder', price: 40, desc: '鼠标（电子）。模型原尺寸 0.05×0.02×0.09 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.1, 0.05, 0.17] },
    { id: 'furn_computer_screen', name: '显示器', url: 'placeholder', price: 40, desc: '显示器（电子）。模型原尺寸 0.39×0.29×0.10 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.79, 0.59, 0.21] },
    { id: 'furn_desk', name: '书桌', url: 'placeholder', price: 60, desc: '书桌（桌台）。模型原尺寸 0.73×0.38×0.39 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.47, 0.77, 0.78] },
    { id: 'furn_desk_corner', name: '转角书桌', url: 'placeholder', price: 60, desc: '转角书桌（桌台）。模型原尺寸 0.97×0.38×0.97 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.95, 0.77, 1.95] },
    { id: 'furn_doorway', name: '门框', url: 'placeholder', price: 48, desc: '门框（建筑构件）。模型原尺寸 0.49×1.01×0.11 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.97, 2.02, 0.23] },
    { id: 'furn_doorway_front', name: '门框(正面)', url: 'placeholder', price: 48, desc: '门框(正面)（建筑构件）。模型原尺寸 0.49×1.01×0.11 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.97, 2.02, 0.23] },
    { id: 'furn_doorway_open', name: '门框(敞开)', url: 'placeholder', price: 48, desc: '门框(敞开)（建筑构件）。模型原尺寸 0.49×1.01×0.09 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.97, 2.02, 0.18] },
    { id: 'furn_dryer', name: '烘干机', url: 'placeholder', price: 85, desc: '烘干机（洗衣）。模型原尺寸 0.39×0.47×0.38 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.78, 0.94, 0.76] },
    { id: 'furn_floor_corner', name: '地板(角)', url: 'placeholder', price: 33, desc: '地板(角)（建筑构件）。模型原尺寸 0.55×0.05×0.55 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.1, 0.1, 1.1] },
    { id: 'furn_floor_corner_round', name: '地板(圆角)', url: 'placeholder', price: 33, desc: '地板(圆角)（建筑构件）。模型原尺寸 0.55×0.05×0.55 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.1, 0.1, 1.1] },
    { id: 'furn_floor_full', name: '地板(整块)', url: 'placeholder', price: 33, desc: '地板(整块)（建筑构件）。模型原尺寸 1.00×0.05×1.00 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [2, 0.1, 2] },
    { id: 'furn_floor_half', name: '地板(半块)', url: 'placeholder', price: 33, desc: '地板(半块)（建筑构件）。模型原尺寸 0.50×0.05×1.00 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.0, 0.1, 2] },
    { id: 'furn_hood_large', name: '抽油烟机(大)', url: 'placeholder', price: 60, desc: '抽油烟机(大)（厨房）。模型原尺寸 0.43×0.37×0.28 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.74, 0.57] },
    { id: 'furn_hood_modern', name: '抽油烟机(现代)', url: 'placeholder', price: 60, desc: '抽油烟机(现代)（厨房）。模型原尺寸 0.43×0.40×0.28 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.8, 0.57] },
    { id: 'furn_kitchen_bar', name: '吧台', url: 'placeholder', price: 60, desc: '吧台（厨房）。模型原尺寸 0.43×0.42×0.21 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.84, 0.42] },
    { id: 'furn_kitchen_bar_end', name: '吧台端', url: 'placeholder', price: 60, desc: '吧台端（厨房）。模型原尺寸 0.10×0.42×0.21 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.2, 0.84, 0.42] },
    { id: 'furn_kitchen_blender', name: '搅拌机', url: 'placeholder', price: 60, desc: '搅拌机（厨房）。模型原尺寸 0.14×0.23×0.11 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.27, 0.46, 0.22] },
    { id: 'furn_kitchen_cabinet', name: '厨柜', url: 'placeholder', price: 60, desc: '厨柜（厨房）。模型原尺寸 0.43×0.45×0.45 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.9, 0.9] },
    { id: 'furn_kitchen_cabinet_corner_inner', name: '厨柜(内角)', url: 'placeholder', price: 60, desc: '厨柜(内角)（厨房）。模型原尺寸 0.46×0.45×0.46 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.92, 0.9, 0.92] },
    { id: 'furn_kitchen_cabinet_corner_round', name: '厨柜(圆角)', url: 'placeholder', price: 60, desc: '厨柜(圆角)（厨房）。模型原尺寸 0.45×0.45×0.45 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.9, 0.9, 0.9] },
    { id: 'furn_kitchen_cabinet_drawer', name: '厨柜(抽屉)', url: 'placeholder', price: 60, desc: '厨柜(抽屉)（厨房）。模型原尺寸 0.43×0.45×0.45 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.9, 0.9] },
    { id: 'furn_kitchen_cabinet_upper', name: '吊柜', url: 'placeholder', price: 60, desc: '吊柜（厨房）。模型原尺寸 0.43×0.39×0.22 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.78, 0.44] },
    { id: 'furn_kitchen_cabinet_upper_corner', name: '吊柜(角)', url: 'placeholder', price: 60, desc: '吊柜(角)（厨房）。模型原尺寸 0.21×0.39×0.21 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.43, 0.78, 0.42] },
    { id: 'furn_kitchen_cabinet_upper_double', name: '吊柜(双)', url: 'placeholder', price: 60, desc: '吊柜(双)（厨房）。模型原尺寸 0.43×0.39×0.22 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.78, 0.44] },
    { id: 'furn_kitchen_cabinet_upper_low', name: '吊柜(矮)', url: 'placeholder', price: 60, desc: '吊柜(矮)（厨房）。模型原尺寸 0.43×0.20×0.22 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.39, 0.44] },
    { id: 'furn_kitchen_coffee_machine', name: '咖啡机', url: 'placeholder', price: 60, desc: '咖啡机（厨房）。模型原尺寸 0.19×0.18×0.24 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.38, 0.35, 0.48] },
    { id: 'furn_kitchen_fridge', name: '冰箱', url: 'placeholder', price: 75, desc: '冰箱（厨房）。模型原尺寸 0.43×0.92×0.29 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 1.84, 0.58] },
    { id: 'furn_kitchen_fridge_built_in', name: '嵌入式冰箱', url: 'placeholder', price: 75, desc: '嵌入式冰箱（厨房）。模型原尺寸 0.43×0.87×0.45 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 1.74, 0.9] },
    { id: 'furn_kitchen_fridge_large', name: '大冰箱', url: 'placeholder', price: 75, desc: '大冰箱（厨房）。模型原尺寸 0.52×0.92×0.41 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.04, 1.84, 0.81] },
    { id: 'furn_kitchen_fridge_small', name: '小冰箱', url: 'placeholder', price: 75, desc: '小冰箱（厨房）。模型原尺寸 0.43×0.60×0.29 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 1.2, 0.58] },
    { id: 'furn_kitchen_microwave', name: '微波炉', url: 'placeholder', price: 60, desc: '微波炉（厨房）。模型原尺寸 0.29×0.18×0.23 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.58, 0.36, 0.46] },
    { id: 'furn_kitchen_sink', name: '厨房水槽', url: 'placeholder', price: 60, desc: '厨房水槽（厨房）。模型原尺寸 0.43×0.49×0.45 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.98, 0.9] },
    { id: 'furn_kitchen_stove', name: '燃气灶', url: 'placeholder', price: 60, desc: '燃气灶（厨房）。模型原尺寸 0.43×0.45×0.45 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.9, 0.9] },
    { id: 'furn_kitchen_stove_electric', name: '电磁灶', url: 'placeholder', price: 60, desc: '电磁灶（厨房）。模型原尺寸 0.43×0.45×0.45 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.9, 0.9] },
    { id: 'furn_lamp_round_floor', name: '圆落地灯', url: 'placeholder', price: 45, desc: '圆落地灯（照明）。模型原尺寸 0.15×0.86×0.18 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.3, 1.72, 0.35] },
    { id: 'furn_lamp_round_table', name: '圆台灯', url: 'placeholder', price: 45, desc: '圆台灯（桌台）。模型原尺寸 0.15×0.31×0.18 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.3, 0.63, 0.35] },
    { id: 'furn_lamp_square_ceiling', name: '方吸顶灯', url: 'placeholder', price: 30, desc: '方吸顶灯（照明）。模型原尺寸 0.12×0.23×0.12 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.24, 0.46, 0.24] },
    { id: 'furn_lamp_square_floor', name: '方落地灯', url: 'placeholder', price: 45, desc: '方落地灯（照明）。模型原尺寸 0.12×0.86×0.12 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.24, 1.72, 0.24] },
    { id: 'furn_lamp_square_table', name: '方台灯', url: 'placeholder', price: 45, desc: '方台灯（桌台）。模型原尺寸 0.12×0.29×0.12 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.24, 0.58, 0.24] },
    { id: 'furn_lamp_wall', name: '壁灯', url: 'placeholder', price: 30, desc: '壁灯（照明）。模型原尺寸 0.23×0.09×0.15 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.45, 0.19, 0.3] },
    { id: 'furn_laptop', name: '笔记本电脑', url: 'placeholder', price: 40, desc: '笔记本电脑（电子）。模型原尺寸 0.26×0.16×0.24 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.53, 0.32, 0.48] },
    { id: 'furn_lounge_chair', name: '休闲椅', url: 'placeholder', price: 40, desc: '休闲椅（坐具/沙发）。模型原尺寸 0.49×0.46×0.41 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.98, 0.92, 0.82] },
    { id: 'furn_lounge_chair_relax', name: '躺椅', url: 'placeholder', price: 55, desc: '躺椅（坐具/沙发）。模型原尺寸 0.49×0.63×0.68 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.98, 1.26, 1.35] },
    { id: 'furn_lounge_design_chair', name: '设计休闲椅', url: 'placeholder', price: 55, desc: '设计休闲椅（坐具/沙发）。模型原尺寸 0.73×0.40×0.41 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.46, 0.8, 0.82] },
    { id: 'furn_lounge_design_sofa', name: '设计沙发', url: 'placeholder', price: 70, desc: '设计沙发（坐具/沙发）。模型原尺寸 1.12×0.40×0.41 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [2.24, 0.8, 0.82] },
    { id: 'furn_lounge_design_sofa_corner', name: '设计转角沙发', url: 'placeholder', price: 70, desc: '设计转角沙发（坐具/沙发）。模型原尺寸 1.35×0.40×1.35 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [2.7, 0.8, 2.7] },
    { id: 'furn_sofa', name: '布艺沙发', url: 'placeholder', price: 55, desc: '布艺沙发（坐具/沙发）。模型原尺寸 0.98×0.46×0.41 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.96, 0.92, 0.82] },
    { id: 'furn_lounge_sofa_corner', name: '转角沙发', url: 'placeholder', price: 55, desc: '转角沙发（坐具/沙发）。模型原尺寸 0.98×0.46×0.98 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.96, 0.92, 1.96] },
    { id: 'furn_lounge_sofa_long', name: '长沙发', url: 'placeholder', price: 55, desc: '长沙发（坐具/沙发）。模型原尺寸 0.98×0.46×0.82 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.96, 0.92, 1.64] },
    { id: 'furn_lounge_sofa_ottoman', name: '沙发脚凳', url: 'placeholder', price: 40, desc: '沙发脚凳（坐具/沙发）。模型原尺寸 0.44×0.23×0.45 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.88, 0.46, 0.9] },
    { id: 'furn_paneling', name: '墙板', url: 'placeholder', price: 33, desc: '墙板（建筑构件）。模型原尺寸 0.50×0.59×0.03 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.0, 1.19, 0.06] },
    { id: 'furn_pillow', name: '抱枕', url: 'placeholder', price: 75, desc: '抱枕（卧室）。模型原尺寸 0.23×0.22×0.09 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.46, 0.44, 0.18] },
    { id: 'furn_pillow_blue', name: '蓝抱枕', url: 'placeholder', price: 75, desc: '蓝抱枕（卧室）。模型原尺寸 0.23×0.13×0.06 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.46, 0.26, 0.13] },
    { id: 'furn_pillow_blue_long', name: '蓝长抱枕', url: 'placeholder', price: 90, desc: '蓝长抱枕（卧室）。模型原尺寸 0.52×0.22×0.09 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.03, 0.44, 0.18] },
    { id: 'furn_pillow_long', name: '长抱枕', url: 'placeholder', price: 75, desc: '长抱枕（卧室）。模型原尺寸 0.39×0.22×0.09 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.77, 0.44, 0.18] },
    { id: 'furn_plant_small1', name: '小盆栽1', url: 'placeholder', price: 22, desc: '小盆栽1（绿植/软装）。模型原尺寸 0.10×0.14×0.10 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.19, 0.28, 0.19] },
    { id: 'furn_plant_small2', name: '小盆栽2', url: 'placeholder', price: 22, desc: '小盆栽2（绿植/软装）。模型原尺寸 0.10×0.14×0.10 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.19, 0.28, 0.19] },
    { id: 'furn_plant_small3', name: '小盆栽3', url: 'placeholder', price: 22, desc: '小盆栽3（绿植/软装）。模型原尺寸 0.10×0.14×0.09 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.2, 0.29, 0.17] },
    { id: 'furn_potted_plant', name: '盆栽', url: 'placeholder', price: 37, desc: '盆栽（绿植/软装）。模型原尺寸 0.21×0.65×0.24 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.42, 1.31, 0.48] },
    { id: 'furn_radio', name: '收音机', url: 'placeholder', price: 40, desc: '收音机（电子）。模型原尺寸 0.32×0.23×0.10 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.63, 0.46, 0.2] },
    { id: 'furn_rug_doormat', name: '门口地垫', url: 'placeholder', price: 22, desc: '门口地垫（绿植/软装）。模型原尺寸 0.43×0.01×0.24 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.02, 0.47] },
    { id: 'furn_rug_rectangle', name: '长方形地毯', url: 'placeholder', price: 52, desc: '长方形地毯（绿植/软装）。模型原尺寸 1.57×0.01×0.92 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [3.14, 0.02, 1.84] },
    { id: 'furn_rug_round', name: '圆形地毯', url: 'placeholder', price: 37, desc: '圆形地毯（绿植/软装）。模型原尺寸 0.92×0.01×0.92 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.84, 0.02, 1.84] },
    { id: 'furn_rug_rounded', name: '圆角地毯', url: 'placeholder', price: 52, desc: '圆角地毯（绿植/软装）。模型原尺寸 1.57×0.01×0.92 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [3.14, 0.02, 1.84] },
    { id: 'furn_rug_square', name: '方形地毯', url: 'placeholder', price: 37, desc: '方形地毯（绿植/软装）。模型原尺寸 0.90×0.01×0.92 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.81, 0.02, 1.84] },
    { id: 'furn_shower', name: '淋浴', url: 'placeholder', price: 95, desc: '淋浴（卫浴）。模型原尺寸 0.56×1.09×0.58 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.12, 2.19, 1.16] },
    { id: 'furn_shower_round', name: '圆淋浴', url: 'placeholder', price: 95, desc: '圆淋浴（卫浴）。模型原尺寸 0.56×1.09×0.56 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.12, 2.19, 1.12] },
    { id: 'furn_side_table', name: '边桌', url: 'placeholder', price: 60, desc: '边桌（桌台）。模型原尺寸 0.53×0.38×0.22 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.07, 0.77, 0.44] },
    { id: 'furn_side_table_drawers', name: '抽屉边桌', url: 'placeholder', price: 60, desc: '抽屉边桌（桌台）。模型原尺寸 0.53×0.38×0.22 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.07, 0.77, 0.44] },
    { id: 'furn_speaker', name: '音箱', url: 'placeholder', price: 55, desc: '音箱（电子）。模型原尺寸 0.15×0.64×0.15 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.3, 1.27, 0.3] },
    { id: 'furn_speaker_small', name: '小音箱', url: 'placeholder', price: 40, desc: '小音箱（电子）。模型原尺寸 0.15×0.30×0.13 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.3, 0.6, 0.27] },
    { id: 'furn_stairs', name: '楼梯', url: 'placeholder', price: 48, desc: '楼梯（建筑构件）。模型原尺寸 1.82×1.34×0.79 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [3.65, 2.68, 1.58] },
    { id: 'furn_stairs_corner', name: '转角楼梯', url: 'placeholder', price: 48, desc: '转角楼梯（建筑构件）。模型原尺寸 1.77×1.34×1.43 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [3.55, 2.68, 2.85] },
    { id: 'furn_stairs_open', name: '开放式楼梯', url: 'placeholder', price: 48, desc: '开放式楼梯（建筑构件）。模型原尺寸 1.82×1.34×0.79 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [3.65, 2.68, 1.58] },
    { id: 'furn_stairs_open_single', name: '单跑开楼梯', url: 'placeholder', price: 48, desc: '单跑开楼梯（建筑构件）。模型原尺寸 1.82×1.34×0.79 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [3.65, 2.68, 1.58] },
    { id: 'furn_stool_bar', name: '吧凳', url: 'placeholder', price: 40, desc: '吧凳（坐具/沙发）。模型原尺寸 0.27×0.43×0.23 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.53, 0.87, 0.46] },
    { id: 'furn_stool_bar_square', name: '方吧凳', url: 'placeholder', price: 40, desc: '方吧凳（坐具/沙发）。模型原尺寸 0.15×0.41×0.15 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.31, 0.81, 0.3] },
    { id: 'furn_table', name: '木桌', url: 'placeholder', price: 60, desc: '木桌（桌台）。模型原尺寸 0.84×0.33×0.45 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.68, 0.65, 0.89] },
    { id: 'furn_table_cloth', name: '铺布桌', url: 'placeholder', price: 60, desc: '铺布桌（桌台）。模型原尺寸 0.84×0.33×0.45 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.68, 0.65, 0.89] },
    { id: 'furn_table_coffee', name: '茶几', url: 'placeholder', price: 60, desc: '茶几（桌台）。模型原尺寸 0.66×0.23×0.40 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.32, 0.46, 0.8] },
    { id: 'furn_table_coffee_glass', name: '玻璃茶几', url: 'placeholder', price: 60, desc: '玻璃茶几（桌台）。模型原尺寸 0.66×0.23×0.40 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.32, 0.46, 0.8] },
    { id: 'furn_table_coffee_glass_square', name: '方玻璃茶几', url: 'placeholder', price: 45, desc: '方玻璃茶几（桌台）。模型原尺寸 0.40×0.23×0.40 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 0.46, 0.8] },
    { id: 'furn_table_coffee_square', name: '方茶几', url: 'placeholder', price: 45, desc: '方茶几（桌台）。模型原尺寸 0.40×0.23×0.40 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 0.46, 0.8] },
    { id: 'furn_table_cross', name: '交叉腿桌', url: 'placeholder', price: 60, desc: '交叉腿桌（桌台）。模型原尺寸 0.85×0.35×0.45 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.7, 0.69, 0.89] },
    { id: 'furn_table_cross_cloth', name: '交叉腿布桌', url: 'placeholder', price: 60, desc: '交叉腿布桌（桌台）。模型原尺寸 0.85×0.35×0.45 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.7, 0.69, 0.89] },
    { id: 'furn_table_glass', name: '玻璃桌', url: 'placeholder', price: 60, desc: '玻璃桌（桌台）。模型原尺寸 0.84×0.33×0.45 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.68, 0.65, 0.89] },
    { id: 'furn_table_round', name: '圆桌', url: 'placeholder', price: 60, desc: '圆桌（桌台）。模型原尺寸 0.69×0.37×0.80 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.39, 0.73, 1.6] },
    { id: 'furn_television_antenna', name: '天线电视', url: 'placeholder', price: 40, desc: '天线电视（电子）。模型原尺寸 0.27×0.10×0.08 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.53, 0.21, 0.16] },
    { id: 'furn_television_modern', name: '现代电视', url: 'placeholder', price: 55, desc: '现代电视（电子）。模型原尺寸 0.69×0.46×0.13 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.37, 0.91, 0.26] },
    { id: 'furn_television_vintage', name: '复古电视', url: 'placeholder', price: 40, desc: '复古电视（电子）。模型原尺寸 0.41×0.27×0.27 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.82, 0.54, 0.54] },
    { id: 'furn_toaster', name: '烤面包机', url: 'placeholder', price: 60, desc: '烤面包机（厨房）。模型原尺寸 0.19×0.13×0.10 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.38, 0.26, 0.2] },
    { id: 'furn_toilet', name: '马桶', url: 'placeholder', price: 65, desc: '马桶（卫浴）。模型原尺寸 0.31×0.45×0.48 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.63, 0.9, 0.95] },
    { id: 'furn_toilet_square', name: '方马桶', url: 'placeholder', price: 65, desc: '方马桶（卫浴）。模型原尺寸 0.30×0.45×0.39 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.61, 0.9, 0.77] },
    { id: 'furn_trashcan', name: '垃圾桶', url: 'placeholder', price: 55, desc: '垃圾桶（柜架/收纳）。模型原尺寸 0.21×0.43×0.23 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.42, 0.86, 0.47] },
    { id: 'furn_wall', name: '墙', url: 'placeholder', price: 48, desc: '墙（建筑构件）。模型原尺寸 1.00×1.29×0.05 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [2, 2.58, 0.1] },
    { id: 'furn_wall_corner', name: '墙角', url: 'placeholder', price: 48, desc: '墙角（建筑构件）。模型原尺寸 0.55×1.29×0.55 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.1, 2.58, 1.1] },
    { id: 'furn_wall_corner_rond', name: '圆角墙角', url: 'placeholder', price: 48, desc: '圆角墙角（建筑构件）。模型原尺寸 0.55×1.29×0.55 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.1, 2.58, 1.1] },
    { id: 'furn_wall_doorway', name: '墙(门洞)', url: 'placeholder', price: 48, desc: '墙(门洞)（建筑构件）。模型原尺寸 1.00×1.29×0.09 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [2, 2.58, 0.18] },
    { id: 'furn_wall_doorway_wide', name: '墙(宽门洞)', url: 'placeholder', price: 48, desc: '墙(宽门洞)（建筑构件）。模型原尺寸 1.00×1.29×0.09 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [2, 2.58, 0.18] },
    { id: 'furn_wall_half', name: '半墙', url: 'placeholder', price: 48, desc: '半墙（建筑构件）。模型原尺寸 0.50×1.29×0.05 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.0, 2.58, 0.1] },
    { id: 'furn_wall_window', name: '墙(窗)', url: 'placeholder', price: 48, desc: '墙(窗)（建筑构件）。模型原尺寸 1.00×1.29×0.09 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [2, 2.58, 0.18] },
    { id: 'furn_wall_window_slide', name: '墙(推拉窗)', url: 'placeholder', price: 48, desc: '墙(推拉窗)（建筑构件）。模型原尺寸 1.00×1.29×0.09 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [2, 2.58, 0.18] },
    { id: 'furn_washer', name: '洗衣机', url: 'placeholder', price: 85, desc: '洗衣机（洗衣）。模型原尺寸 0.39×0.47×0.39 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.78, 0.94, 0.78] },
    { id: 'furn_washer_dryer_stacked', name: '洗烘一体', url: 'placeholder', price: 100, desc: '洗烘一体（洗衣）。模型原尺寸 0.39×0.94×0.39 m。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.78, 1.88, 0.78] },
];

// 已下架商品 id：老 shop.json 里还留着它们，服务端那份过滤要 scp 才生效 ——
// 这里再来一份，让「下架」在前端**立刻**生效，不至于店里还挂着一个买了没用的道具。
// ⚠ 与 server-remote/index.js 的 RETIRED_IDS 必须一致（两边都是「下架名单」这一个来源的两份副本）。
const RETIRED_IDS = new Set(['flashlight']); // 手电筒：2026-10-07 按用户要求下架

// 目录可被服务端覆盖：GET /api/shop 拉到的最新商品表。为 null 时回退到上面写死的 SHOP_ITEMS。
let CATALOG = null;
// 合并而非整体替换：以服务端列表覆盖同名商品（价格/描述），但保留客户端写死、
// 而服务端漏发的商品（例如刚加的新道具还没 scp 到服务器时）。否则服务端比前端旧的那段时间里，
// 新道具会整条被冲掉 —— 店里买不到、isOwned 恒 false，看起来就像「道具没做」。
export function setCatalog(items) {
  if (!Array.isArray(items)) return;
  const byId = new Map();
  for (const it of SHOP_ITEMS) if (it && it.id) byId.set(it.id, it); // 客户端基准
  for (const it of items) if (it && it.id) byId.set(it.id, it);       // 服务端覆盖/补充
  CATALOG = [...byId.values()].filter((it) => !RETIRED_IDS.has(String(it.id))); // 剔掉已下架的
}
export function getCatalog() {
  return CATALOG || SHOP_ITEMS;
}
// 查商品：优先服务端目录，其次写死兜底（断网也能买）
export function findItem(itemId) {
  const id = String(itemId);
  const list = CATALOG || SHOP_ITEMS;
  return list.find((it) => it.id === id) || null;
}
// 按显示名查商品：背包只存名字，渲染图标/归类时需要用名字反查目录项
export function itemByName(name) {
  const n = String(name);
  const list = CATALOG || SHOP_ITEMS;
  return list.find((it) => it.name === n) || null;
}
// 家具（可摆放的 building 商品）的名字集合：背包用它把「家具」页签与普通道具分开。
// 家具按「名字」存进背包（背包只认名字），所以这里也以名字为键。
export function furnitureNames() {
  const set = new Set();
  for (const it of (CATALOG || SHOP_ITEMS)) if (it.kind === 'building') set.add(it.name);
  return set;
}
// 某玩家还没摆出来的家具数量 = 背包里该家具名的件数
// （家具买下即进背包，随背包云同步到账号；换设备也是同一份）
export function unplacedCount(profile, itemId) {
  const it = findItem(itemId);
  if (!it) return 0;
  return loadBag(getBagKey(profile))[it.name] || 0;
}
// 摆出成功后从背包消耗 1 件，返回剩余数量
export function consumeOwned(profile, itemId) {
  const it = findItem(itemId);
  if (!it) return 0;
  return removeFromBag(getBagKey(profile), it.name, 1);
}
// 一次性迁移：把旧版记在 wallet.owned 里的家具（按 id 计数）搬进背包（按名字计数）。
// 幂等：owned 里没有家具时是空操作。在拿到商店目录后调用即可。
export function migrateFurnitureToBag(profile) {
  const w = loadWallet(profile);
  const furn = (CATALOG || SHOP_ITEMS).filter((it) => it.kind === 'building');
  let moved = 0;
  for (const it of furn) {
    let n = 0;
    while (w.owned.includes(it.id)) { w.owned.splice(w.owned.indexOf(it.id), 1); n++; }
    if (n > 0) { addToBag(getBagKey(profile), it.name, n); moved += n; }
  }
  if (moved) saveWallet(profile, w);
  return moved;
}

function walletKey(profile) {
  const id = profile ? (profile.username || profile.nickname || '') : '';
  return KEY_PREFIX + (id || 'guest');
}

// 读钱包：{ coins: 学币数, owned: [已购商品 id], redeemed: [已用过的兑换码] }
export function loadWallet(profile) {
  try {
    const raw = JSON.parse(localStorage.getItem(walletKey(profile)) || '{}');
    return {
      coins: Math.max(0, Math.floor(Number(raw && raw.coins) || 0)),
      owned: Array.isArray(raw && raw.owned) ? raw.owned.map(String) : [],
      redeemed: Array.isArray(raw && raw.redeemed) ? raw.redeemed.map(String) : [],
    };
  } catch (e) {
    return { coins: 0, owned: [], redeemed: [] };
  }
}

function saveWallet(profile, w) {
  try {
    localStorage.setItem(walletKey(profile), JSON.stringify(w));
  } catch (e) {
    /* 存储不可用：本次会话内仍然是同一个对象，界面照常工作 */
  }
  markSaveDirty(); // 学币/已购是账号存档的一部分 → 触发云同步
}

// 加/扣学币。返回变动后的余额。
export function addCoins(profile, n) {
  const w = loadWallet(profile);
  w.coins = Math.max(0, w.coins + Math.floor(Number(n) || 0));
  saveWallet(profile, w);
  return w.coins;
}

export function isOwned(profile, itemId) {
  return loadWallet(profile).owned.includes(String(itemId));
}

// 购买：学币不够才拒绝；已拥有的商品可以重复购买（多买几个用来丢/送人）。
// owned 只记录「曾经买过」，用于界面标记与首购提示，不用于拦截。
// 成功返回 { ok:true, coins, item, repeat }，失败返回 { ok:false, reason }。
export function buyItem(profile, itemId) {
  const item = findItem(itemId);
  if (!item) return { ok: false, reason: '没有这件商品' };
  const w = loadWallet(profile);
  const repeat = w.owned.includes(item.id);
  if (w.coins < item.price) return { ok: false, reason: '学币不够（还差 ' + (item.price - w.coins) + '）' };
  w.coins -= item.price;
  // 家具不算「已拥有道具」（它进背包、按件数计），只有普通道具才记进 owned
  if (item.kind !== 'building' && !repeat) w.owned.push(item.id);
  saveWallet(profile, w);
  return { ok: true, coins: w.coins, item, repeat };
}

// 击败老师之类的奖励入口统一走这里，方便以后调数值
export function rewardBossKill(profile) {
  return addCoins(profile, Config.BOSS_COIN_REWARD);
}

// 兑换码：**校验与记账都在服务端**（POST /api/redeem），客户端不再内置码表。
// 为什么搬走：码表写在前端 = 谁都能从 JS 里翻出来；「用过没有」只记在本地 localStorage
// = 清一次缓存就能重复领。服务端按身份记账（登录 u:<id> / 游客 anon:<真实 IP>），
// 这里只负责把服务端返回的学币入账（并存一份本地 redeemed 记录，省掉重复请求）。
// token：登录会话令牌（游客传空串，服务端按 IP 记账）。
// 失败（网络不通 / 老服务端没有该接口）给一句人话，**不做本地兜底** —— 兜底就等于把码表又搬回前端。
// 成功返回 { ok:true, coins, value }，失败返回 { ok:false, reason }。
export async function redeemCode(profile, code, token) {
  const c = String(code || '').trim();
  if (!c) return { ok: false, reason: '请输入兑换码' };
  const out = await accountApi('POST', '/api/redeem', { code: c }, token);
  if (!out) return { ok: false, reason: '兑换服务暂时不可用，请稍后再试' };
  if (!out.ok) {
    const msg = String(out.error || '');
    // 老服务端没有这个接口时会回 not found —— 直接说人话，别让玩家以为是码错了
    if (msg === 'not found') return { ok: false, reason: '服务端还没更新（缺少兑换接口），请先更新后端' };
    return { ok: false, reason: msg || '兑换失败' };
  }
  const value = Math.max(0, Math.floor(Number(out.value) || 0));
  const key = c.toLowerCase().replace(/\s+/g, '');
  const w = loadWallet(profile);
  if (!w.redeemed.includes(key)) w.redeemed.push(key);
  w.coins += value;
  saveWallet(profile, w);
  return { ok: true, coins: w.coins, value };
}
