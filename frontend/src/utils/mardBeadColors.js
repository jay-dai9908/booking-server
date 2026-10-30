// MARD 拼豆色號完整資料庫 (預設內建 298 色：含標準 221 色 A~M + 特殊色系 L高透/P珠光/Q溫變/R半透/T亮片/Y夜光/Z光變，並支援後台無限擴充)

export const MARD_SERIES_INFO = [
  { id: 'A', key: 'A', name: 'A 系列', label: 'A 黃橘暖色', shortLabel: 'A系', group: 'standard', description: '明亮黃、暖陽橘與奶油杏色系' },
  { id: 'B', key: 'B', name: 'B 系列', label: 'B 翠綠森林', shortLabel: 'B系', group: 'standard', description: '嫩芽綠、薄荷綠與深林綠色系' },
  { id: 'C', key: 'C', name: 'C 系列', label: 'C 晴空海洋', shortLabel: 'C系', group: 'standard', description: '冰川藍、天藍與深海靛藍色系' },
  { id: 'D', key: 'D', name: 'D 系列', label: 'D 紫羅蘭系', shortLabel: 'D系', group: 'standard', description: '薰衣草紫、丁香紫與魅影紫色系' },
  { id: 'E', key: 'E', name: 'E 系列', label: 'E 櫻花玫瑰', shortLabel: 'E系', group: 'standard', description: '蜜桃粉、櫻花粉與玫瑰桃色系' },
  { id: 'F', key: 'F', name: 'F 系列', label: 'F 緋紅珊瑚', shortLabel: 'F系', group: 'standard', description: '珊瑚紅、正紅與酒紅磚紅色系' },
  { id: 'G', key: 'G', name: 'G 系列', label: 'G 膚色大地', shortLabel: 'G系', group: 'standard', description: '人物膚色、奶茶色與木質棕色系' },
  { id: 'H', key: 'H', name: 'H 系列', label: 'H 黑白灰階', shortLabel: 'H系', group: 'standard', description: '純白、純黑與多層次冷暖灰階' },
  { id: 'M', key: 'M', name: 'M 系列', label: 'M 莫蘭迪色', shortLabel: 'M系', group: 'standard', description: '低飽和復古灰調莫蘭迪色系' },
  { id: 'L', key: 'L', name: 'L 高透系列', label: 'L 高透系列', shortLabel: 'L 高透', group: 'special', badge: '💧 高透', description: 'L1~L7 高透光玻璃質感色系' },
  { id: 'P', key: 'P', name: 'P 珠光系列', label: 'P 珠光系列', shortLabel: 'P 珠光', group: 'special', badge: '✨ 珠光', description: '帶有細緻珠光光澤，隨角度閃耀' },
  { id: 'Q', key: 'Q', name: 'Q 溫變系列', label: 'Q 溫變系列', shortLabel: 'Q 溫變', group: 'special', badge: '🌡️ 溫變', description: '隨溫度高低產生雙色漸層轉換' },
  { id: 'R', key: 'R', name: 'R 半透系列', label: 'R 半透系列', shortLabel: 'R 半透', group: 'special', badge: '🍬 半透', description: '晶瑩剔透的半透明果凍質感' },
  { id: 'T', key: 'T', name: 'T 亮片系列', label: 'T 亮片系列', shortLabel: 'T 亮片', group: 'special', badge: '💎 亮片', description: '內含璀璨細閃亮片的透明色系' },
  { id: 'Y', key: 'Y', name: 'Y 夜光系列', label: 'Y 夜光系列', shortLabel: 'Y 夜光', group: 'special', badge: '🌙 夜光', description: '吸光後於暗處散發柔和夜光' },
  { id: 'Z', key: 'Z', name: 'Z 光變系列', label: 'Z 光變系列', shortLabel: 'Z 光變', group: 'special', badge: '☀️ 光變', description: '未照光呈透明白色，受陽光/UV照射後顯色' }
];

export const DEFAULT_MARD_COLORS = [
  // A 系列 (26色)
  { code: 'A1', series: 'A', hex: '#F9F0CD' },
  { code: 'A2', series: 'A', hex: '#FBFBD4' },
  { code: 'A3', series: 'A', hex: '#FAFC9F' },
  { code: 'A4', series: 'A', hex: '#FFE953' },
  { code: 'A5', series: 'A', hex: '#F4D738' },
  { code: 'A6', series: 'A', hex: '#FDAD49' },
  { code: 'A7', series: 'A', hex: '#FF7C2F' },
  { code: 'A8', series: 'A', hex: '#EACA49' },
  { code: 'A9', series: 'A', hex: '#FF995A' },
  { code: 'A10', series: 'A', hex: '#FF9D55' },
  { code: 'A11', series: 'A', hex: '#FFDD99' },
  { code: 'A12', series: 'A', hex: '#FCB58F' },
  { code: 'A13', series: 'A', hex: '#FFBB59' },
  { code: 'A14', series: 'A', hex: '#FF6D40' },
  { code: 'A15', series: 'A', hex: '#FDFF44' },
  { code: 'A16', series: 'A', hex: '#FEF9AE' },
  { code: 'A17', series: 'A', hex: '#FFE36E' },
  { code: 'A18', series: 'A', hex: '#FECF98' },
  { code: 'A19', series: 'A', hex: '#FD7B72' },
  { code: 'A20', series: 'A', hex: '#EFCD67' },
  { code: 'A21', series: 'A', hex: '#FFE395' },
  { code: 'A22', series: 'A', hex: '#FFF3A4' },
  { code: 'A23', series: 'A', hex: '#F3D5BF' },
  { code: 'A24', series: 'A', hex: '#FBF8C9' },
  { code: 'A25', series: 'A', hex: '#FFD67D' },
  { code: 'A26', series: 'A', hex: '#FFBB27' },

  // B 系列 (32色)
  { code: 'B1', series: 'B', hex: '#E6EE32' },
  { code: 'B2', series: 'B', hex: '#5BE419' },
  { code: 'B3', series: 'B', hex: '#7CEE9D' },
  { code: 'B4', series: 'B', hex: '#1EF942' },
  { code: 'B5', series: 'B', hex: '#00BD35' },
  { code: 'B6', series: 'B', hex: '#5AE8BA' },
  { code: 'B7', series: 'B', hex: '#03AC88' },
  { code: 'B8', series: 'B', hex: '#029D26' },
  { code: 'B9', series: 'B', hex: '#26523A' },
  { code: 'B10', series: 'B', hex: '#95D3C2' },
  { code: 'B11', series: 'B', hex: '#5D722A' },
  { code: 'B12', series: 'B', hex: '#156F40' },
  { code: 'B13', series: 'B', hex: '#D9F794' },
  { code: 'B14', series: 'B', hex: '#ADE945' },
  { code: 'B15', series: 'B', hex: '#2E5132' },
  { code: 'B16', series: 'B', hex: '#C6ED9C' },
  { code: 'B17', series: 'B', hex: '#9BB13A' },
  { code: 'B18', series: 'B', hex: '#E6EE49' },
  { code: 'B19', series: 'B', hex: '#25B88C' },
  { code: 'B20', series: 'B', hex: '#C2F0CC' },
  { code: 'B21', series: 'B', hex: '#146A6B' },
  { code: 'B22', series: 'B', hex: '#0B3C43' },
  { code: 'B23', series: 'B', hex: '#303921' },
  { code: 'B24', series: 'B', hex: '#EEFCA5' },
  { code: 'B25', series: 'B', hex: '#4E846D' },
  { code: 'B26', series: 'B', hex: '#8C7A36' },
  { code: 'B27', series: 'B', hex: '#D1DCC1' },
  { code: 'B28', series: 'B', hex: '#9EE5B9' },
  { code: 'B29', series: 'B', hex: '#C5E254' },
  { code: 'B30', series: 'B', hex: '#ECFBD0' },
  { code: 'B31', series: 'B', hex: '#C4E6B5' },
  { code: 'B32', series: 'B', hex: '#9BAB5A' },

  // C 系列 (29色)
  { code: 'C1', series: 'C', hex: '#E8FFE7' },
  { code: 'C2', series: 'C', hex: '#BCF9F6' },
  { code: 'C3', series: 'C', hex: '#A0E2FB' },
  { code: 'C4', series: 'C', hex: '#42CCFF' },
  { code: 'C5', series: 'C', hex: '#01ACEB' },
  { code: 'C6', series: 'C', hex: '#50A9F0' },
  { code: 'C7', series: 'C', hex: '#0188D3' },
  { code: 'C8', series: 'C', hex: '#1054C0' },
  { code: 'C9', series: 'C', hex: '#314BCA' },
  { code: 'C10', series: 'C', hex: '#3EBCE2' },
  { code: 'C11', series: 'C', hex: '#03B9B9' },
  { code: 'C12', series: 'C', hex: '#1C334D' },
  { code: 'C13', series: 'C', hex: '#CDE8FF' },
  { code: 'C14', series: 'C', hex: '#D5FDFF' },
  { code: 'C15', series: 'C', hex: '#23C4C6' },
  { code: 'C16', series: 'C', hex: '#1757A8' },
  { code: 'C17', series: 'C', hex: '#50D3EC' },
  { code: 'C18', series: 'C', hex: '#1C3344' },
  { code: 'C19', series: 'C', hex: '#1787A2' },
  { code: 'C20', series: 'C', hex: '#0082BE' },
  { code: 'C21', series: 'C', hex: '#BEDDFF' },
  { code: 'C22', series: 'C', hex: '#67B4BE' },
  { code: 'C23', series: 'C', hex: '#C2DCEB' },
  { code: 'C24', series: 'C', hex: '#7DC4FF' },
  { code: 'C25', series: 'C', hex: '#A9E5E5' },
  { code: 'C26', series: 'C', hex: '#2F99B3' },
  { code: 'C27', series: 'C', hex: '#EBF5FC' },
  { code: 'C28', series: 'C', hex: '#BBCFED' },
  { code: 'C29', series: 'C', hex: '#4B5BA3' },

  // D 系列 (26色)
  { code: 'D1', series: 'D', hex: '#AEB4F2' },
  { code: 'D2', series: 'D', hex: '#858EDD' },
  { code: 'D3', series: 'D', hex: '#3054AF' },
  { code: 'D4', series: 'D', hex: '#182A84' },
  { code: 'D5', series: 'D', hex: '#B843C5' },
  { code: 'D6', series: 'D', hex: '#AC7BDE' },
  { code: 'D7', series: 'D', hex: '#6E399A' },
  { code: 'D8', series: 'D', hex: '#E2D3FF' },
  { code: 'D9', series: 'D', hex: '#D5B9F8' },
  { code: 'D10', series: 'D', hex: '#361B50' },
  { code: 'D11', series: 'D', hex: '#B9BAE1' },
  { code: 'D12', series: 'D', hex: '#DE9AD4' },
  { code: 'D13', series: 'D', hex: '#B90295' },
  { code: 'D14', series: 'D', hex: '#8B279B' },
  { code: 'D15', series: 'D', hex: '#2F1F90' },
  { code: 'D16', series: 'D', hex: '#E2E1EE' },
  { code: 'D17', series: 'D', hex: '#C4D4F6' },
  { code: 'D18', series: 'D', hex: '#A45EC7' },
  { code: 'D19', series: 'D', hex: '#D8C3D7' },
  { code: 'D20', series: 'D', hex: '#9C32B2' },
  { code: 'D21', series: 'D', hex: '#9A009B' },
  { code: 'D22', series: 'D', hex: '#333995' },
  { code: 'D23', series: 'D', hex: '#EADAFC' },
  { code: 'D24', series: 'D', hex: '#7786E5' },
  { code: 'D25', series: 'D', hex: '#484FC7' },
  { code: 'D26', series: 'D', hex: '#E9C3F6' },

  // E 系列 (24色)
  { code: 'E1', series: 'E', hex: '#FDD3CC' },
  { code: 'E2', series: 'E', hex: '#FECDDF' },
  { code: 'E3', series: 'E', hex: '#FF97C3' },
  { code: 'E4', series: 'E', hex: '#E8649E' },
  { code: 'E5', series: 'E', hex: '#F551A2' },
  { code: 'E6', series: 'E', hex: '#FF346B' },
  { code: 'E7', series: 'E', hex: '#C63578' },
  { code: 'E8', series: 'E', hex: '#FFDBE9' },
  { code: 'E9', series: 'E', hex: '#E970CC' },
  { code: 'E10', series: 'E', hex: '#D33893' },
  { code: 'E11', series: 'E', hex: '#FCDDD2' },
  { code: 'E12', series: 'E', hex: '#FFA1C5' },
  { code: 'E13', series: 'E', hex: '#B6006D' },
  { code: 'E14', series: 'E', hex: '#FFD1BA' },
  { code: 'E15', series: 'E', hex: '#F2CFD0' },
  { code: 'E16', series: 'E', hex: '#FFECDE' },
  { code: 'E17', series: 'E', hex: '#FFE2EA' },
  { code: 'E18', series: 'E', hex: '#FFC9D6' },
  { code: 'E19', series: 'E', hex: '#FFD2E7' },
  { code: 'E20', series: 'E', hex: '#D8C7D1' },
  { code: 'E21', series: 'E', hex: '#BD9DA1' },
  { code: 'E22', series: 'E', hex: '#CC78A7' },
  { code: 'E23', series: 'E', hex: '#937A8D' },
  { code: 'E24', series: 'E', hex: '#F6E4F9' },

  // F 系列 (25色)
  { code: 'F1', series: 'F', hex: '#FD957B' },
  { code: 'F2', series: 'F', hex: '#FC3D45' },
  { code: 'F3', series: 'F', hex: '#F74941' },
  { code: 'F4', series: 'F', hex: '#FC283C' },
  { code: 'F5', series: 'F', hex: '#D80127' },
  { code: 'F6', series: 'F', hex: '#B0443D' },
  { code: 'F7', series: 'F', hex: '#971937' },
  { code: 'F8', series: 'F', hex: '#BC0127' },
  { code: 'F9', series: 'F', hex: '#E2677A' },
  { code: 'F10', series: 'F', hex: '#A74D22' },
  { code: 'F11', series: 'F', hex: '#6F201F' },
  { code: 'F12', series: 'F', hex: '#FD4D6A' },
  { code: 'F13', series: 'F', hex: '#DD422F' },
  { code: 'F14', series: 'F', hex: '#FFA9AD' },
  { code: 'F15', series: 'F', hex: '#C80020' },
  { code: 'F16', series: 'F', hex: '#FFD9C8' },
  { code: 'F17', series: 'F', hex: '#F79B71' },
  { code: 'F18', series: 'F', hex: '#D37C46' },
  { code: 'F19', series: 'F', hex: '#C1444A' },
  { code: 'F20', series: 'F', hex: '#CD9391' },
  { code: 'F21', series: 'F', hex: '#F4B1B4' },
  { code: 'F22', series: 'F', hex: '#FFD0CB' },
  { code: 'F23', series: 'F', hex: '#F57E66' },
  { code: 'F24', series: 'F', hex: '#FCC1C4' },
  { code: 'F25', series: 'F', hex: '#E54B4F' },

  // G 系列 (21色)
  { code: 'G1', series: 'G', hex: '#FFE2CE' },
  { code: 'G2', series: 'G', hex: '#FFCAAA' },
  { code: 'G3', series: 'G', hex: '#F4C3A5' },
  { code: 'G4', series: 'G', hex: '#E1B383' },
  { code: 'G5', series: 'G', hex: '#ED9435' },
  { code: 'G6', series: 'G', hex: '#F59734' },
  { code: 'G7', series: 'G', hex: '#9D5B3E' },
  { code: 'G8', series: 'G', hex: '#592A21' },
  { code: 'G9', series: 'G', hex: '#E6B483' },
  { code: 'G10', series: 'G', hex: '#C88135' },
  { code: 'G11', series: 'G', hex: '#E0C593' },
  { code: 'G12', series: 'G', hex: '#EBBB83' },
  { code: 'G13', series: 'G', hex: '#B7714A' },
  { code: 'G14', series: 'G', hex: '#8D614C' },
  { code: 'G15', series: 'G', hex: '#FCF9E0' },
  { code: 'G16', series: 'G', hex: '#F2D9BA' },
  { code: 'G17', series: 'G', hex: '#56403C' },
  { code: 'G18', series: 'G', hex: '#FFE4CC' },
  { code: 'G19', series: 'G', hex: '#E1943A' },
  { code: 'G20', series: 'G', hex: '#A94023' },
  { code: 'G21', series: 'G', hex: '#CB8E77' },

  // H 系列 (23色)
  { code: 'H1', series: 'H', hex: '#E2E2E2' },
  { code: 'H2', series: 'H', hex: '#FFFFFF', name: '純白' },
  { code: 'H3', series: 'H', hex: '#B3B3B3' },
  { code: 'H4', series: 'H', hex: '#868686' },
  { code: 'H5', series: 'H', hex: '#474747' },
  { code: 'H6', series: 'H', hex: '#2C2C2C' },
  { code: 'H7', series: 'H', hex: '#000000', name: '純黑' },
  { code: 'H8', series: 'H', hex: '#E7D6DB' },
  { code: 'H9', series: 'H', hex: '#E4E7E3' },
  { code: 'H10', series: 'H', hex: '#EEE9EA' },
  { code: 'H11', series: 'H', hex: '#CECDD5' },
  { code: 'H12', series: 'H', hex: '#FFF5ED' },
  { code: 'H13', series: 'H', hex: '#F3E1C9' },
  { code: 'H14', series: 'H', hex: '#CFD7D3' },
  { code: 'H15', series: 'H', hex: '#98A6A8' },
  { code: 'H16', series: 'H', hex: '#3B2F23' },
  { code: 'H17', series: 'H', hex: '#F1EDED' },
  { code: 'H18', series: 'H', hex: '#FFFDF0' },
  { code: 'H19', series: 'H', hex: '#F6EFE2' },
  { code: 'H20', series: 'H', hex: '#949FA3' },
  { code: 'H21', series: 'H', hex: '#F7F3E4' },
  { code: 'H22', series: 'H', hex: '#CACAD5' },
  { code: 'H23', series: 'H', hex: '#9A9D94' },

  // M 系列 (15色)
  { code: 'M1', series: 'M', hex: '#BCC6B8' },
  { code: 'M2', series: 'M', hex: '#8AA385' },
  { code: 'M3', series: 'M', hex: '#697D80' },
  { code: 'M4', series: 'M', hex: '#DACEBE' },
  { code: 'M5', series: 'M', hex: '#D0CCAA' },
  { code: 'M6', series: 'M', hex: '#B0A782' },
  { code: 'M7', series: 'M', hex: '#B4A497' },
  { code: 'M8', series: 'M', hex: '#B38281' },
  { code: 'M9', series: 'M', hex: '#A58767' },
  { code: 'M10', series: 'M', hex: '#C5B1BC' },
  { code: 'M11', series: 'M', hex: '#9F7494' },
  { code: 'M12', series: 'M', hex: '#644749' },
  { code: 'M13', series: 'M', hex: '#D19066' },
  { code: 'M14', series: 'M', hex: '#C77361' },
  { code: 'M15', series: 'M', hex: '#757D7B' },

  // L 系列 - 高透系列 (1~7 共7色)
  { code: 'L1', series: 'L', hex: '#F2F7FA', name: '高透透明', effect: '高透' },
  { code: 'L2', series: 'L', hex: '#FFF168', name: '高透亮黃', effect: '高透' },
  { code: 'L3', series: 'L', hex: '#5CE68B', name: '高透翠綠', effect: '高透' },
  { code: 'L4', series: 'L', hex: '#58C4FF', name: '高透晴藍', effect: '高透' },
  { code: 'L5', series: 'L', hex: '#B882FF', name: '高透薰衣紫', effect: '高透' },
  { code: 'L6', series: 'L', hex: '#FF8EC6', name: '高透櫻花粉', effect: '高透' },
  { code: 'L7', series: 'L', hex: '#FFA04D', name: '高透活力橙', effect: '高透' },

  // P 系列 - 珠光系列 (23色)
  { code: 'P1', series: 'P', hex: '#FCF8F9', name: '珠光白', effect: '珠光' },
  { code: 'P2', series: 'P', hex: '#BDA9AB', name: '珠光銀灰', effect: '珠光' },
  { code: 'P3', series: 'P', hex: '#AEDDA9', name: '珠光薄荷綠', effect: '珠光' },
  { code: 'P4', series: 'P', hex: '#FDA49E', name: '珠光珊瑚粉', effect: '珠光' },
  { code: 'P5', series: 'P', hex: '#EC8D3D', name: '珠光暖橘', effect: '珠光' },
  { code: 'P6', series: 'P', hex: '#60CFA8', name: '珠光湖水綠', effect: '珠光' },
  { code: 'P7', series: 'P', hex: '#EB9271', name: '珠光蜜桃橘', effect: '珠光' },
  { code: 'P8', series: 'P', hex: '#F0D958', name: '珠光金黃', effect: '珠光' },
  { code: 'P9', series: 'P', hex: '#D9D9D9', name: '珠光珍珠銀', effect: '珠光' },
  { code: 'P10', series: 'P', hex: '#D5C8E9', name: '珠光薰衣草紫', effect: '珠光' },
  { code: 'P11', series: 'P', hex: '#F3ECC8', name: '珠光香檳金', effect: '珠光' },
  { code: 'P12', series: 'P', hex: '#E6EEF1', name: '珠光冰川白', effect: '珠光' },
  { code: 'P13', series: 'P', hex: '#A9CBF1', name: '珠光天藍', effect: '珠光' },
  { code: 'P14', series: 'P', hex: '#3177B0', name: '珠光寶石藍', effect: '珠光' },
  { code: 'P15', series: 'P', hex: '#668575', name: '珠光墨玉綠', effect: '珠光' },
  { code: 'P16', series: 'P', hex: '#FFBE46', name: '珠光向日葵黃', effect: '珠光' },
  { code: 'P17', series: 'P', hex: '#FFA324', name: '珠光亮金橘', effect: '珠光' },
  { code: 'P18', series: 'P', hex: '#FEB89F', name: '珠光粉膚杏', effect: '珠光' },
  { code: 'P19', series: 'P', hex: '#FFE0E8', name: '珠光櫻花粉', effect: '珠光' },
  { code: 'P20', series: 'P', hex: '#FEBECF', name: '珠光甜美粉', effect: '珠光' },
  { code: 'P21', series: 'P', hex: '#ECBEC0', name: '珠光玫瑰粉', effect: '珠光' },
  { code: 'P22', series: 'P', hex: '#E4A89E', name: '珠光豆沙粉', effect: '珠光' },
  { code: 'P23', series: 'P', hex: '#A56269', name: '珠光乾燥玫瑰', effect: '珠光' },

  // Q 系列 - 溫變系列 (5色，支援雙色漸層顯示)
  {
    code: 'Q1',
    series: 'Q',
    hex: '#F2A5E8',
    subHex: '#FFF7FD',
    name: '溫變紫粉➔淺白',
    effect: '溫變',
    gradient: 'linear-gradient(135deg, #F2A5E8 0%, #FAD6F4 52%, #FFF7FD 100%)'
  },
  {
    code: 'Q2',
    series: 'Q',
    hex: '#73B29E',
    subHex: '#E9EC91',
    name: '溫變青綠➔嫩黃',
    effect: '溫變',
    gradient: 'linear-gradient(135deg, #73B29E 0%, #B4D4B0 52%, #E9EC91 100%)'
  },
  {
    code: 'Q3',
    series: 'Q',
    hex: '#FFFF00',
    subHex: '#FFFDF2',
    name: '溫變亮黃➔淺白',
    effect: '溫變',
    gradient: 'linear-gradient(135deg, #F59E0B 0%, #FFFF00 50%, #FFFDF2 100%)'
  },
  {
    code: 'Q4',
    series: 'Q',
    hex: '#FFEBFA',
    subHex: '#FFFFFF',
    name: '溫變櫻粉➔透白',
    effect: '溫變',
    gradient: 'linear-gradient(135deg, #FF85B3 0%, #FFD4E8 52%, #FFFFFF 100%)'
  },
  {
    code: 'Q5',
    series: 'Q',
    hex: '#4F5E5B',
    subHex: '#76CEDE',
    name: '溫變墨綠➔冰藍',
    effect: '溫變',
    gradient: 'linear-gradient(135deg, #4F5E5B 0%, #5F9BA6 52%, #76CEDE 100%)'
  },

  // R 系列 - 半透系列 (28色)
  { code: 'R1', series: 'R', hex: '#D50E21', name: '半透正紅', effect: '半透' },
  { code: 'R2', series: 'R', hex: '#F92E83', name: '半透桃紅', effect: '半透' },
  { code: 'R3', series: 'R', hex: '#FD8225', name: '半透亮橘', effect: '半透' },
  { code: 'R4', series: 'R', hex: '#F8EC31', name: '半透檸檬黃', effect: '半透' },
  { code: 'R5', series: 'R', hex: '#34C75B', name: '半透翠綠', effect: '半透' },
  { code: 'R6', series: 'R', hex: '#25B891', name: '半透松石綠', effect: '半透' },
  { code: 'R7', series: 'R', hex: '#17779D', name: '半透海藍', effect: '半透' },
  { code: 'R8', series: 'R', hex: '#1B60C3', name: '半透寶藍', effect: '半透' },
  { code: 'R9', series: 'R', hex: '#9A56B4', name: '半透葡萄紫', effect: '半透' },
  { code: 'R10', series: 'R', hex: '#FFDB4D', name: '半透暖黃', effect: '半透' },
  { code: 'R11', series: 'R', hex: '#FFEBFA', name: '半透冰粉白', effect: '半透' },
  { code: 'R12', series: 'R', hex: '#D8D5CE', name: '半透霧灰白', effect: '半透' },
  { code: 'R13', series: 'R', hex: '#55514C', name: '半透煙燻黑', effect: '半透' },
  { code: 'R14', series: 'R', hex: '#9EE4DF', name: '半透薄荷冰藍', effect: '半透' },
  { code: 'R15', series: 'R', hex: '#77CEE9', name: '半透天空藍', effect: '半透' },
  { code: 'R16', series: 'R', hex: '#3DCFCA', name: '半透蒂芬妮藍', effect: '半透' },
  { code: 'R17', series: 'R', hex: '#4A867A', name: '半透湖水深綠', effect: '半透' },
  { code: 'R18', series: 'R', hex: '#7FCD9D', name: '半透嫩芽綠', effect: '半透' },
  { code: 'R19', series: 'R', hex: '#CDE55D', name: '半透青檸綠', effect: '半透' },
  { code: 'R20', series: 'R', hex: '#E8C7B4', name: '半透奶茶膚', effect: '半透' },
  { code: 'R21', series: 'R', hex: '#AD6F3C', name: '半透焦糖琥珀', effect: '半透' },
  { code: 'R22', series: 'R', hex: '#6C372F', name: '半透紅棕茶', effect: '半透' },
  { code: 'R23', series: 'R', hex: '#FEB872', name: '半透蜜桃杏', effect: '半透' },
  { code: 'R24', series: 'R', hex: '#F2C1C0', name: '半透櫻花粉', effect: '半透' },
  { code: 'R25', series: 'R', hex: '#C9675D', name: '半透珊瑚紅', effect: '半透' },
  { code: 'R26', series: 'R', hex: '#D293BE', name: '半透丁香粉紫', effect: '半透' },
  { code: 'R27', series: 'R', hex: '#EA8CB1', name: '半透玫瑰粉', effect: '半透' },
  { code: 'R28', series: 'R', hex: '#9C87D6', name: '半透薰衣草紫', effect: '半透' },

  // T 系列 - 亮片系列 (1色)
  { code: 'T1', series: 'T', hex: '#E2DFD7', name: '亮片透明白', effect: '亮片' },

  // Y 系列 - 夜光系列 (5色)
  { code: 'Y1', series: 'Y', hex: '#FD6FB4', name: '夜光甜心粉', effect: '夜光' },
  { code: 'Y2', series: 'Y', hex: '#FEB481', name: '夜光暖陽橘', effect: '夜光' },
  { code: 'Y3', series: 'Y', hex: '#D7FAA0', name: '夜光螢光綠', effect: '夜光' },
  { code: 'Y4', series: 'Y', hex: '#8BDBFA', name: '夜光星空藍', effect: '夜光' },
  { code: 'Y5', series: 'Y', hex: '#E987EA', name: '夜光極光紫', effect: '夜光' },

  // Z 系列 (原 ZG 系列) - 光變系列 (8色，支援白➔顯色漸層顯示，對齊 pixel-beads 色卡)
  {
    code: 'Z1',
    series: 'Z',
    hex: '#F28985',
    subHex: '#F6BFB7',
    effect: '光變',
    name: '光變粉紅',
    gradient: 'linear-gradient(135deg, #FFFFFF 0%, #F6BFB7 48%, #F28985 100%)'
  },
  {
    code: 'Z2',
    series: 'Z',
    hex: '#ECA55D',
    subHex: '#F1D1BA',
    effect: '光變',
    name: '光變暖橘',
    gradient: 'linear-gradient(135deg, #FFFFFF 0%, #F1D1BA 48%, #ECA55D 100%)'
  },
  {
    code: 'Z3',
    series: 'Z',
    hex: '#E8CE6A',
    subHex: '#EEDDCE',
    effect: '光變',
    name: '光變亮黃',
    gradient: 'linear-gradient(135deg, #FFFFFF 0%, #EEDDCE 48%, #E8CE6A 100%)'
  },
  {
    code: 'Z4',
    series: 'Z',
    hex: '#88C772',
    subHex: '#C6DAC4',
    effect: '光變',
    name: '光變嫩綠',
    gradient: 'linear-gradient(135deg, #FFFFFF 0%, #C6DAC4 48%, #88C772 100%)'
  },
  {
    code: 'Z5',
    series: 'Z',
    hex: '#718CBF',
    subHex: '#E7DAB7',
    effect: '光變',
    name: '光變靛藍',
    gradient: 'linear-gradient(135deg, #FFFFFF 0%, #E7DAB7 48%, #718CBF 100%)'
  },
  {
    code: 'Z6',
    series: 'Z',
    hex: '#77ACD2',
    subHex: '#B9E3E4',
    effect: '光變',
    name: '光變晴藍',
    gradient: 'linear-gradient(135deg, #FFFFFF 0%, #B9E3E4 48%, #77ACD2 100%)'
  },
  {
    code: 'Z7',
    series: 'Z',
    hex: '#E88F8C',
    subHex: '#EFD9C9',
    effect: '光變',
    name: '光變珊瑚',
    gradient: 'linear-gradient(135deg, #FFFFFF 0%, #EFD9C9 48%, #E88F8C 100%)'
  },
  {
    code: 'Z8',
    series: 'Z',
    hex: '#AE84BD',
    subHex: '#F3E8D4',
    effect: '光變',
    name: '光變紫羅蘭',
    gradient: 'linear-gradient(135deg, #FFFFFF 0%, #F3E8D4 48%, #AE84BD 100%)'
  }
];

/**
 * Natural sort for bead color codes (e.g. A1, A2, ..., A10, B1, Z1)
 */
export const sortBeadColors = (colors) => {
  return [...colors].sort((a, b) => {
    const matchA = String(a.code || '').match(/^([A-Za-z]+)(\d+)$/);
    const matchB = String(b.code || '').match(/^([A-Za-z]+)(\d+)$/);
    if (matchA && matchB) {
      const prefixCmp = matchA[1].toUpperCase().localeCompare(matchB[1].toUpperCase());
      if (prefixCmp !== 0) return prefixCmp;
      return parseInt(matchA[2], 10) - parseInt(matchB[2], 10);
    }
    return String(a.code || '').localeCompare(String(b.code || ''));
  });
};

/**
 * Normalize legacy effect codes to readable Chinese labels
 */
const normalizeEffectLabel = (effect, series) => {
  if (!effect || effect === '標準色') {
    if (series === 'L') return '高透';
    if (series === 'P') return '珠光';
    if (series === 'Q') return '溫變';
    if (series === 'R') return '半透';
    if (series === 'T') return '亮片';
    if (series === 'Y') return '夜光';
    if (series === 'Z') return '光變';
    return '標準色';
  }
  const map = {
    pearl: '珠光',
    thermo: '溫變',
    jelly: '半透',
    果凍: '半透',
    transparent: '亮片',
    透明: '亮片',
    glitter: '亮片',
    glow: '夜光',
    uv: '光變'
  };
  return map[effect] || effect;
};

/**
 * Merge built-in 298 colors with admin custom/override colors from GlobalSetting.bead_colors_json
 */
export const getMergedBeadColors = (customColorsJson) => {
  const colorMap = new Map();

  for (const item of DEFAULT_MARD_COLORS) {
    const code = item.code.toUpperCase();
    const series = (item.series || code.replace(/\d+$/, '') || 'A').toUpperCase();
    colorMap.set(code, {
      ...item,
      code,
      series,
      effect: normalizeEffectLabel(item.effect, series),
      is_available: true,
      is_builtin: true
    });
  }

  if (Array.isArray(customColorsJson)) {
    for (const custom of customColorsJson) {
      if (!custom || !custom.code) continue;
      const cleanCode = String(custom.code)
        .trim()
        .toUpperCase()
        .replace(/^ZG(\d+)$/, 'Z$1');
      if (!cleanCode) continue;

      if (custom.is_deleted) {
        colorMap.delete(cleanCode);
        continue;
      }

      const existing = colorMap.get(cleanCode);
      const inferredSeries = (
        custom.series ||
        cleanCode.replace(/\d+$/, '') ||
        existing?.series ||
        'OTHER'
      )
        .trim()
        .toUpperCase();

      // Use built-in rich name if custom only stored empty string or the raw code itself
      const resolvedName =
        custom.name && String(custom.name).trim() && String(custom.name).trim().toUpperCase() !== cleanCode
          ? String(custom.name).trim()
          : existing?.name || custom.name || '';

      // If L1~L7 was previously added with the modal's default #FF88AA placeholder, prefer the built-in L-series hex
      const resolvedHex =
        existing && custom.hex === '#FF88AA' && inferredSeries === 'L'
          ? existing.hex
          : custom.hex || existing?.hex || '#CCCCCC';

      const resolvedEffect = normalizeEffectLabel(
        custom.effect && custom.effect !== '標準色' ? custom.effect : existing?.effect || custom.effect,
        inferredSeries
      );

      // Build or preserve gradient for color-changing series (Z 光變 / Q 溫變)
      let resolvedGradient = custom.gradient || existing?.gradient || null;
      if (!resolvedGradient && (inferredSeries === 'Z' || resolvedEffect === '光變')) {
        resolvedGradient = `linear-gradient(135deg, #FFFFFF 0%, ${custom.subHex || '#F3E8D4'} 48%, ${resolvedHex} 100%)`;
      } else if (!resolvedGradient && (inferredSeries === 'Q' || resolvedEffect === '溫變')) {
        resolvedGradient = `linear-gradient(135deg, ${resolvedHex} 0%, ${custom.subHex || '#FFFDF2'} 100%)`;
      }

      colorMap.set(cleanCode, {
        ...(existing || {}),
        ...custom,
        code: cleanCode,
        series: inferredSeries,
        hex: resolvedHex,
        name: resolvedName,
        effect: resolvedEffect,
        gradient: resolvedGradient,
        is_available: custom.is_available !== false
      });
    }
  }

  return sortBeadColors(Array.from(colorMap.values()));
};

/**
 * Calculate contrasting text color (#2C241E or #FFFFFF) for a given hex background
 */
export const getContrastTextColor = (hex) => {
  if (!hex || typeof hex !== 'string') return '#3E332B';
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return '#3E332B';
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? '#2C241E' : '#FFFFFF';
};

/**
 * Return inline style for a bead color swatch, supporting CSS linear-gradient for color-changing beads (Q溫變 / Z光變)
 */
export const getBeadSwatchStyle = (colorObj) => {
  if (!colorObj) return { backgroundColor: '#CCCCCC', color: '#2C241E' };
  if (colorObj.gradient) {
    return {
      background: colorObj.gradient,
      color: '#2C241E',
      textShadow: '0 0 3px rgba(255, 255, 255, 0.95)'
    };
  }
  const hex = colorObj.hex || '#CCCCCC';
  return {
    backgroundColor: hex,
    color: getContrastTextColor(hex)
  };
};

/**
 * Calculate tiered subtotal for a given quantity of a single item/group
 */
export const calculateSingleGroupTierTotal = (product, qty) => {
  if (!product || !qty || qty <= 0) return 0;
  if (Array.isArray(product.tier_pricing) && product.tier_pricing.length > 0) {
    const sortedTiers = [...product.tier_pricing].sort((a, b) => (b.qty || 0) - (a.qty || 0));
    let remaining = qty;
    let total = 0;
    for (const tier of sortedTiers) {
      if (remaining >= tier.qty && tier.qty > 0) {
        const count = Math.floor(remaining / tier.qty);
        total += count * tier.price;
        remaining = remaining % tier.qty;
      }
    }
    if (remaining > 0) {
      total += remaining * product.price;
    }
    return total;
  }
  return product.price * qty;
};

/**
 * Calculate beads subtotal supporting BOTH:
 * - 'combined' (混色合計包數達標即折)
 * - 'per_color' (單一色號各自買滿包數才折)
 */
export const calculateBeadsSubtotalWithMode = (product, totalQty, colorBreakdown = {}) => {
  if (!product || !totalQty || totalQty <= 0) return 0;
  const mode = product.tier_discount_mode || 'combined';

  if (mode === 'per_color' && colorBreakdown && typeof colorBreakdown === 'object') {
    const entries = Object.entries(colorBreakdown).filter(([, cQty]) => Number(cQty) > 0);
    if (entries.length > 0) {
      let sumSubtotal = 0;
      let remainingToAllocate = totalQty;
      for (const [, cQtyRaw] of entries) {
        if (remainingToAllocate <= 0) break;
        const cQty = Math.min(remainingToAllocate, Math.max(0, parseInt(cQtyRaw, 10) || 0));
        if (cQty > 0) {
          remainingToAllocate -= cQty;
          sumSubtotal += calculateSingleGroupTierTotal(product, cQty);
        }
      }
      // If totalQty exceeds allocated colors (e.g. manual adjustment), charge remaining at unit price
      if (remainingToAllocate > 0) {
        sumSubtotal += remainingToAllocate * product.price;
      }
      return sumSubtotal;
    }
  }

  return calculateSingleGroupTierTotal(product, totalQty);
};
