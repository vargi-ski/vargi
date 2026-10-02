// Shared catalogue for the storefront and order builder. Fixed prices; stock as of 2026-09-22.
window.VARGI_SHOP = [
  {
    "name": "Футболка «Классика»",
    "desc": "Плотный высококачественный <strong>турецкий хлопок</strong> — мягкий, приятный к телу, сохраняющий форму и вид.",
    "material": "100% турецкий хлопок",
    "price": "3 990 ₽",
    "img": "/assets/vargi-shirt-classic-2026.jpg",
    "available": true,
    "id": "shirt-classic",
    "basePrice": 3990,
    "sizeKind": "clothing",
    "stock": {
      "S": 6,
      "M": 9,
      "L": 4
    },
    "category": "cotton"
  },
  {
    "name": "Футболка «Белая классика»",
    "desc": "Плотный высококачественный <strong>турецкий хлопок</strong> — мягкий, приятный к телу, сохраняющий форму и вид.",
    "material": "100% турецкий хлопок",
    "price": "3 990 ₽",
    "img": "/assets/vargi-shirt-white-classic-2026.jpg",
    "available": true,
    "id": "shirt-white-classic",
    "basePrice": 3990,
    "sizeKind": "clothing",
    "stock": {
      "S": 3,
      "M": 5,
      "L": 3
    },
    "category": "cotton"
  },
  {
    "name": "Футболка «Стая держит темп»",
    "desc": "Плотный высококачественный <strong>турецкий хлопок</strong> — мягкий, приятный к телу, сохраняющий форму и вид.",
    "material": "100% турецкий хлопок",
    "price": "3 990 ₽",
    "img": "/assets/vargi-shirt-pack-keeps-pace-2026.jpg",
    "available": true,
    "id": "shirt-pack-tempo",
    "basePrice": 3990,
    "sizeKind": "clothing",
    "stock": {
      "S": 6,
      "M": 8,
      "L": 4
    },
    "category": "cotton"
  },
  {
    "bg": "#FFFFFF",
    "name": "Спортивная футболка «Север внутри»",
    "desc": "Лёгкая. Эластичная. Дышащая.<br>Произведена из высокотехнологичного функционального материала, быстро отводит влагу, поддерживает комфортную температуру тела.",
    "material": "90% полиэстер · 10% эластан",
    "price": "3 400 ₽",
    "img": "/assets/shop-sport-sever-vnutri-2026.webp",
    "imageFormat": "landscape",
    "available": true,
    "id": "shirt-sport-sever",
    "basePrice": 3400,
    "sizeKind": "clothing",
    "stock": {
      "XS": 3,
      "S": 10
    },
    "category": "training"
  },
  {
    "bg": "#111111",
    "name": "Тренировочная футболка «Минимализм»",
    "desc": "Лёгкая. Эластичная. Дышащая.<br>Произведена из высокотехнологичного функционального материала, быстро отводит влагу, поддерживает комфортную температуру тела.",
    "material": "90% полиэстер · 10% эластан",
    "price": "3 400 ₽",
    "img": "/assets/shop-training-minimalism-black-2026.webp",
    "imageFormat": "landscape",
    "available": true,
    "id": "shirt-training-minimal",
    "basePrice": 3400,
    "sizeKind": "clothing",
    "stock": {
      "S": 5,
      "M": 5
    },
    "category": "training"
  },
  {
    "bg": "#111111",
    "name": "Кепка «Прямой козырёк»",
    "desc": "Чёрная. Прямой козырёк, герб ВАРГИ спереди и девиз «Стая держит темп» сзади.",
    "price": "2 500 ₽",
    "img": "/assets/shop-cap-straight-clean-v2-2026.webp",
    "imageFormat": "landscape",
    "available": false,
    "id": "cap-straight",
    "basePrice": 2500,
    "sizeKind": "cap",
    "preorder": true,
    "preorderLeadTime": "1 месяц",
    "category": "caps"
  },
  {
    "bg": "#111111",
    "name": "Кепка «Спортивная классика»",
    "desc": "Чёрная. Классический изогнутый козырёк, герб ВАРГИ спереди и девиз «Стая держит темп» сзади.",
    "price": "2 500 ₽",
    "img": "/assets/shop-cap-classic-clean-v2-2026.webp",
    "imageFormat": "landscape",
    "available": false,
    "id": "cap-classic",
    "basePrice": 2500,
    "sizeKind": "cap",
    "preorder": true,
    "preorderLeadTime": "1 месяц",
    "category": "caps"
  },
  {
    "name": "Лыжный гоночный костюм",
    "desc": "Раздельный лыжный гоночный костюм стаи.",
    "price": "13 900 ₽",
    "img": "/assets/shop-race-suit-front-back-2026.webp",
    "available": false,
    "id": "race-suit",
    "basePrice": 13900,
    "sizeKind": "clothing",
    "preorder": true,
    "preorderRelease": "конец ноября 2026",
    "category": "racing"
  },
  {
    "name": "Пуховик",
    "desc": "Тёплый пуховик стаи. Ближе к сезону.",
    "price": "Скоро",
    "img": "",
    "soon": true,
    "id": "down-jacket",
    "category": "upcoming"
  },
  {
    "name": "Разминка",
    "desc": "Разминочный костюм стаи. Ближе к сезону.",
    "price": "Скоро",
    "img": "",
    "soon": true,
    "id": "warmup-suit",
    "category": "upcoming"
  },
  {
    "name": "Шапка / бафф",
    "desc": "Зимний комплект. Ближе к сезону.",
    "price": "Скоро",
    "img": "",
    "soon": true,
    "id": "hat-buff",
    "category": "upcoming"
  }
];

window.VARGI_SHOP_CATEGORIES = [
  {
    "id": "cotton",
    "title": "Хлопковые футболки",
    "preview": "shirt-classic"
  },
  {
    "id": "training",
    "title": "Тренировочные футболки",
    "preview": "shirt-sport-sever"
  },
  {
    "id": "caps",
    "title": "Кепки",
    "preview": "cap-straight"
  },
  {
    "id": "racing",
    "title": "Гоночные костюмы",
    "preview": "race-suit"
  }
];
