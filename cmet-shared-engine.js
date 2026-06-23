
(function (global) {
'use strict';

var selectedMaterials = {
    walls: null,
    floors: null,
    bathroomFloors: null,
    ceilings: [],
    electrical: [],
    plumbing: [],
    wallTile: null,
    lighting: [],
    windowsDoors: [],
    additionalFloors: [],
    additionalWalls: [],
    additionalWallTile: [],
    additionalBathroomFloors: [],
    demolition: [],
    partitions: [],
    bathroomPorcelainTrayEnabled: false,
    bathroomPorcelainTraySqm: 0
};

/** Площадь кладки одного блока Сибит 625×250 мм (лицо 0,625×0,25 м) — для поддона из керамогранита и пеноблока. */
const GAS_BLOCK_FACE_SQM = 0.625 * 0.25;

/** Базовая толщина слоя (мм), под которую заданы нормы расхода в корзине. */
const LAYER_THICKNESS_BASE_MM = { plaster: 10, screed: 50, selfLeveling: 5 };

/** Саморезы под маяки (ЛМ «на вес»): перевод штук → кг для корзины. */
const BEACON_SCREW_35151_KG_PER_1000 = 4.5;  /* 3.5×51 */
const BEACON_SCREW_4270_KG_PER_1000 = 7.0;   /* 4.2×70 */

function beaconScrewKgFromPieces(pieces, kgPer1000) {
    if (!(pieces > 0) || !(kgPer1000 > 0)) return 0;
    return (pieces / 1000) * kgPer1000;
}

function layerThicknessQtyFactor(thicknessMm, baseMm) {
    if (thicknessMm == null || thicknessMm === undefined) return 1;
    const t = typeof thicknessMm === 'number' ? thicknessMm : parseFloat(String(thicknessMm).replace(',', '.'));
    if (isNaN(t) || t <= 0) return 1;
    const b = baseMm > 0 ? baseMm : 1;
    return t / b;
}

/** Демпферная лента Isodom 88698314: рулон 10 м (10×0,1 м). */
const DAMPING_TAPE_ROLL_LEN_M = 10;

function floorPerimeterMFromAreaSqm(areaSqm) {
    if (!(areaSqm > 0)) return 0;
    return 4 * Math.sqrt(areaSqm);
}

/** Периметр плинтуса: сумма 4×√S по комнатам жилой части (без санузлов). */
function skirtingPerimeterMFromRoomsData(roomsData, totalLivingAreaFallback) {
    let totalPerimeter = 0;
    (roomsData || []).forEach(function (room) {
        const a = parseFloat(String(room.area != null ? room.area : '').replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
        if (a > 0) totalPerimeter += floorPerimeterMFromAreaSqm(a);
    });
    if (totalPerimeter <= 0 && totalLivingAreaFallback != null) {
        const ta = parseFloat(String(totalLivingAreaFallback).replace(',', '.')) || 0;
        if (ta > 0) totalPerimeter = floorPerimeterMFromAreaSqm(ta);
    }
    return totalPerimeter;
}

function skirtingPerimeterMFromCalcObj(c) {
    if (!c) return 0;
    return skirtingPerimeterMFromRoomsData(c.roomWallsDetails, c.livingArea);
}

function parseSkirtingPerimeterFromMaterial(m) {
    if (!m) return 0;
    if (m.perimeterM != null) {
        const pm = typeof m.perimeterM === 'number' ? m.perimeterM : parseFloat(String(m.perimeterM).replace(',', '.'));
        if (!isNaN(pm) && pm > 0) return pm;
    }
    if (m.area) {
        const s = String(m.area);
        if (/п\.?\s*м/i.test(s)) {
            const n = parseFloat(s.replace(/[^\d.,-]/g, '').replace(',', '.'));
            if (!isNaN(n) && n > 0) return n;
        }
    }
    return 0;
}

function dampingTapeRollsFromFloorAreaSqm(areaSqm) {
    const p = floorPerimeterMFromAreaSqm(areaSqm);
    if (!(p > 0)) return 0;
    return p / DAMPING_TAPE_ROLL_LEN_M;
}

function selfLevelingEffectiveThicknessMm(thicknessMm) {
    if (thicknessMm != null && thicknessMm !== undefined) {
        const t = typeof thicknessMm === 'number' ? thicknessMm : parseFloat(String(thicknessMm).replace(',', '.'));
        if (!isNaN(t) && t > 0) return t;
    }
    return LAYER_THICKNESS_BASE_MM.selfLeveling;
}

/** Расценки укладки керамической плитки и керамогранита в смете (₽/кв.м.). */
const ESTIMATE_RATE_TILE_CERAMIC_SQM = 2600;
const ESTIMATE_RATE_TILE_PORCELAIN_SQM = 2800;
const ESTIMATE_RATE_TILE_CEMENT_GROUT_SQM = 150;
const ESTIMATE_RATE_MOSAIC_CEMENT_GROUT_SQM = 350;
const ESTIMATE_RATE_PRIMER_SQM = 50;

function pushTileCementGrout(items, areaSqm) {
    const a = parseFloat(areaSqm) || 0;
    if (a <= 0 || !items) return;
    items.push({
        name: "Затирка плитки цементной затиркой",
        rate: ESTIMATE_RATE_TILE_CEMENT_GROUT_SQM,
        quantity: a.toFixed(1),
        unit: "кв.м.",
        total: (a * ESTIMATE_RATE_TILE_CEMENT_GROUT_SQM).toFixed(1)
    });
}

function pushMosaicCementGrout(items, areaSqm) {
    const a = parseFloat(areaSqm) || 0;
    if (a <= 0 || !items) return;
    items.push({
        name: "Затирка мозаики цементной затиркой",
        rate: ESTIMATE_RATE_MOSAIC_CEMENT_GROUT_SQM,
        quantity: a.toFixed(1),
        unit: "кв.м.",
        total: (a * ESTIMATE_RATE_MOSAIC_CEMENT_GROUT_SQM).toFixed(1)
    });
}

function pushCementGroutForTileType(items, tileType, areaSqm) {
    if (tileType === 'mosaic') pushMosaicCementGrout(items, areaSqm);
    else if (tileType === 'tile' || tileType === 'porcelain' || tileType === 'ceramic') pushTileCementGrout(items, areaSqm);
}

/** Тариф работы «Наливной пол» в смете (₽/м²) по толщине слоя из подраздела (пусто — база 5 мм → 400). */
function selfLevelingWorkRatePerSqm(thicknessMm) {
    const t = selfLevelingEffectiveThicknessMm(thicknessMm);
    if (t > 20) return 800;
    if (t > 10) return 600;
    return 400;
}

/** Слои грунтовки пола в смете и СТ17: +1 при напольном покрытии; +1 за стяжку; +1 за наливной. */
function floorPrimerLayerCount(additionalFloorsArr, includeCoveringLayer) {
    let layers = 0;
    if (includeCoveringLayer) layers += 1;
    if (additionalFloorsArr && additionalFloorsArr.length > 0) {
        if (additionalFloorsArr.some(function (m) { return m.type === 'screed'; })) layers += 1;
        if (additionalFloorsArr.some(function (m) { return m.type === 'selfLeveling'; })) layers += 1;
    }
    return layers > 0 ? layers : 1;
}

/** Слои грунтовки потолка в смете и СТ17: +1 под штукатурку, шпаклёвку или покраску (суммируются). */
function ceilingPrimerLayerCount(ceilingsArr) {
    if (!ceilingsArr || !ceilingsArr.length) return 0;
    let layers = 0;
    if (ceilingsArr.some(function (c) { return c && c.type === 'plasterCeiling'; })) layers += 1;
    if (ceilingsArr.some(function (c) { return c && c.type === 'puttyCeiling'; })) layers += 1;
    if (ceilingsArr.some(function (c) { return c && c.type === 'paintCeiling'; })) layers += 1;
    return layers;
}

function ceilingPrimerName(layers) {
    if (layers <= 1) return 'Грунтовка потолка';
    if (layers >= 2 && layers <= 4) return 'Грунтовка потолка (' + layers + ' слоя)';
    return 'Грунтовка потолка (' + layers + ' слоёв)';
}

function isWallPuttySpravType(t) {
    return t === 'putty' || t === 'puttyWallpaper' || t === 'puttyPaint';
}

function hasWallpaperWallScope(sm) {
    if (!sm) return false;
    if (sm.wallsVariants && sm.wallsVariants.length) {
        return sm.wallsVariants.some(function (v) { return v && v.type === 'wallpaper'; });
    }
    return Boolean(sm.walls && sm.walls.type === 'wallpaper');
}

/** Типы чистовой отделки стен без грунтовки CT17 (Радуга-27 — обои, покраска, декоративная штукатурка). */
function isWallFinishWithoutCt17(t) {
    return t === 'wallpaper' || t === 'paint' || t === 'panels' || t === 'gypsumFrame' || t === 'decorative';
}

function hasDecorativeWallScope(sm) {
    if (!sm) return false;
    if (sm.walls && sm.walls.type === 'decorative') return true;
    if (sm.wallsVariants && sm.wallsVariants.length) {
        return sm.wallsVariants.some(function (v) { return v && v.type === 'decorative'; });
    }
    return false;
}

/** Площадь стен под пропитку Радуга-27 — обои и покраска (корзина; в смете — в строке «Грунтовка акриловая стен»). */
function computeRadugaWallpaperPaintSqm(sm) {
    if (!sm) return 0;
    let total = 0;
    getLivingWallFinishVariants(sm).forEach(function (wv) {
        if (!wv || (wv.type !== 'wallpaper' && wv.type !== 'paint')) return;
        const sq = parseAreaStringToSqm(wv.area);
        if (sq != null && sq > 0) total += sq;
    });
    return total;
}

/** Площадь декоративной штукатурки стен под Радуга-27 (корзина; в смете — в строке «Грунтовка акриловая стен»). */
function computeRadugaDecorativeWallSqm(sm) {
    if (!sm) return 0;
    let total = 0;
    getLivingWallFinishVariants(sm).forEach(function (wv) {
        if (!wv || wv.type !== 'decorative') return;
        const sq = parseAreaStringToSqm(wv.area);
        if (sq != null && sq > 0) total += sq;
    });
    return total;
}

function wallPuttyLayersForType(t) {
    return t === 'puttyPaint' ? 3 : 2;
}

function wallPuttyEstimateLabel(t) {
    if (t === 'puttyPaint') return 'Шпаклёвка стен под окраску (3 слоя)';
    if (t === 'puttyWallpaper') return 'Шпаклёвка стен под обои (2 слоя)';
    return 'Шпаклёвка стен (2 слоя)';
}

function pushWallAcrylicPrimerLine(items, totalAreaSq) {
    const sq = parseFloat(totalAreaSq) || 0;
    if (sq <= 0) return;
    items.push({
        name: 'Грунтовка акриловая стен',
        rate: ESTIMATE_RATE_PRIMER_SQM,
        quantity: sq.toFixed(1),
        unit: 'кв.м.',
        total: (sq * ESTIMATE_RATE_PRIMER_SQM).toFixed(1)
    });
}

function getLivingWallFinishVariants(sm) {
    if (!sm) return [];
    if (sm.wallsVariants && sm.wallsVariants.length) return sm.wallsVariants;
    if (sm.walls) return [sm.walls];
    return [];
}

/** Сумма м² грунтовки: по каждой отмеченной позиции стен — её выбранная площадь. */
function computeTotalWallLivingPrimerSqm(sm) {
    if (!sm) return 0;
    let total = 0;
    (sm.additionalWalls || []).forEach(function (m) {
        if (m.type === 'plaster' || isWallPuttySpravType(m.type)) {
            const sq = parseAreaStringToSqm(m.area);
            if (sq != null && sq > 0) total += sq;
        }
    });
    getLivingWallFinishVariants(sm).forEach(function (wv) {
        if (!wv || isWallFinishWithoutCt17(wv.type)) return;
        const sq = parseAreaStringToSqm(wv.area);
        if (sq != null && sq > 0) total += sq;
    });
    return total;
}

function wallFinishWorkRow(type) {
    let wallWorkRate = 0;
    let wallWorkName = "";
    switch (type) {
        case 'paint':
            wallWorkRate = 300;
            wallWorkName = "Покраска стен";
            break;
        case 'wallpaper':
            wallWorkRate = 300;
            wallWorkName = "Поклейка обоев";
            break;
        case 'decorative':
            wallWorkRate = 950;
            wallWorkName = "Декоративная штукатурка";
            break;
        case 'panels':
            wallWorkRate = 950;
            wallWorkName = "Установка панелей";
            break;
        case 'tile':
            wallWorkRate = ESTIMATE_RATE_TILE_CERAMIC_SQM;
            wallWorkName = "Укладка керамической плитки на стенах";
            break;
        case 'porcelain':
            wallWorkRate = ESTIMATE_RATE_TILE_PORCELAIN_SQM;
            wallWorkName = "Укладка керамогранита на стенах";
            break;
        case 'plaster':
            wallWorkRate = 350;
            wallWorkName = "Штукатурка стен";
            break;
        case 'gypsumFrame':
            wallWorkRate = 850;
            wallWorkName = "Обшивка стен гипсокартоном на каркасе";
            break;
        default:
            wallWorkRate = 0;
            wallWorkName = "Неизвестный материал";
            break;
    }
    return { wallWorkRate: wallWorkRate, wallWorkName: wallWorkName };
}

function hasLivingWallEstimateWorks(sm) {
    if (!sm) return false;
    if (getLivingWallFinishVariants(sm).length) return true;
    return (sm.additionalWalls || []).some(function (m) {
        return m.type === 'plaster' || isWallPuttySpravType(m.type) || m.type === 'ceramicGraniteApron';
    });
}

function buildLivingWallsEstimateItems(sm) {
    const items = [];
    const ct17WallSqm = computeTotalWallLivingPrimerSqm(sm);
    const radugaWallSqm = computeRadugaWallpaperPaintSqm(sm) + computeRadugaDecorativeWallSqm(sm);
    const wallPrimerEstimateSqm = ct17WallSqm + radugaWallSqm;
    if (wallPrimerEstimateSqm > 0) pushWallAcrylicPrimerLine(items, wallPrimerEstimateSqm);

    const plasterAreaSqmTotal = getWallPlasterAreaSqm(sm.additionalWalls);
    if (plasterAreaSqmTotal > 0) {
        items.push({
            name: "Штукатурка стен",
            rate: 550,
            quantity: plasterAreaSqmTotal.toFixed(1),
            unit: "кв.м.",
            total: (plasterAreaSqmTotal * 550).toFixed(1)
        });
    }

    (sm.additionalWalls || []).forEach(function (puttyMat) {
        if (!isWallPuttySpravType(puttyMat.type)) return;
        const puttyAreaSq = parseFloat(String(puttyMat.area || '').replace(' м²', '').replace(',', '.')) || 0;
        pushWallPuttyEstimateItem(items, puttyAreaSq, puttyMat.type);
    });
    const totalSanding = computeTotalWallLivingSandingSqm(sm);
    if (totalSanding > 0) pushWallSandingLine(items, totalSanding);

    getLivingWallFinishVariants(sm).forEach(function (wv) {
        const row = wallFinishWorkRow(wv.type);
        const a = parseFloat(String(wv.area || '').replace(' м²', '').replace(',', '.')) || 0;
        if (row.wallWorkRate > 0 && a > 0) {
            items.push({
                name: row.wallWorkName,
                rate: row.wallWorkRate,
                quantity: a.toFixed(1),
                unit: "кв.м.",
                total: (a * row.wallWorkRate).toFixed(1)
            });
            if (wv.type === 'tile' || wv.type === 'porcelain') {
                pushTileCementGrout(items, a);
            }
        }
    });

    (sm.additionalWalls || []).forEach(function (additionalMaterial) {
        if (additionalMaterial.type === 'plaster' || isWallPuttySpravType(additionalMaterial.type)) return;
        if (additionalMaterial.type !== 'ceramicGraniteApron') return;
        const additionalArea = parseFloat(String(additionalMaterial.area || '').replace(' м²', '').replace(',', '.')) || 0;
        if (additionalArea <= 0) return;
        items.push({
            name: "Укладка фартука из керамогранита",
            rate: ESTIMATE_RATE_TILE_PORCELAIN_SQM,
            quantity: additionalArea.toFixed(1),
            unit: "кв.м.",
            total: (additionalArea * ESTIMATE_RATE_TILE_PORCELAIN_SQM).toFixed(1)
        });
        pushTileCementGrout(items, additionalArea);
    });

    return items;
}

function pushFloorPrimerLine(items, totalAreaSq) {
    const sq = parseFloat(totalAreaSq) || 0;
    if (sq <= 0) return;
    items.push({
        name: 'Грунтовка пола',
        rate: ESTIMATE_RATE_PRIMER_SQM,
        quantity: sq.toFixed(1),
        unit: 'кв.м.',
        total: (sq * ESTIMATE_RATE_PRIMER_SQM).toFixed(1)
    });
}

function pushBathroomWallPrimerLine(items, totalAreaSq) {
    const sq = parseFloat(totalAreaSq) || 0;
    if (sq <= 0) return;
    items.push({
        name: 'Грунтовка стен',
        rate: ESTIMATE_RATE_PRIMER_SQM,
        quantity: sq.toFixed(1),
        unit: 'кв.м.',
        total: (sq * ESTIMATE_RATE_PRIMER_SQM).toFixed(1)
    });
}

function isLivingAdditionalFloor(m) {
    return !m || String(m.name || '').indexOf('санузел') < 0;
}

function getLivingFloorFinishVariants(sm) {
    if (!sm) return [];
    if (sm.floorsVariants && sm.floorsVariants.length) return sm.floorsVariants;
    if (sm.floors) return [sm.floors];
    return [];
}

function getLivingAdditionalFloors(sm) {
    return (sm.additionalFloors || []).filter(isLivingAdditionalFloor);
}

function computeTotalLivingFloorPrimerSqm(sm) {
    if (!sm) return 0;
    let total = 0;
    getLivingFloorFinishVariants(sm).forEach(function (f) {
        const sq = parseAreaStringToSqm(f.area);
        if (sq != null && sq > 0) total += sq;
    });
    getLivingAdditionalFloors(sm).forEach(function (m) {
        if (m.type === 'screed' || m.type === 'selfLeveling') {
            const sq = parseAreaStringToSqm(m.area);
            if (sq != null && sq > 0) total += sq;
        }
    });
    return total;
}

function floorFinishWorkRow(type) {
    let floorWorkRate = 0;
    let floorWorkName = "";
    switch (type) {
        case 'laminate':
            floorWorkRate = 650;
            floorWorkName = "Укладка ламината";
            break;
        case 'pvc':
            floorWorkRate = 650;
            floorWorkName = "Укладка ПВХ плитки";
            break;
        case 'tile':
            floorWorkRate = ESTIMATE_RATE_TILE_CERAMIC_SQM;
            floorWorkName = "Укладка керамической плитки";
            break;
        case 'porcelain':
            floorWorkRate = ESTIMATE_RATE_TILE_PORCELAIN_SQM;
            floorWorkName = "Укладка керамогранита";
            break;
        case 'mosaic':
            floorWorkRate = 3000;
            floorWorkName = "Укладка мозаики";
            break;
        case 'parquet':
            floorWorkRate = 950;
            floorWorkName = "Укладка паркета";
            break;
        case 'linoleum':
            floorWorkRate = 450;
            floorWorkName = "Укладка линолеума";
            break;
        case 'carpet':
            floorWorkRate = 650;
            floorWorkName = "Укладка ковролина";
            break;
        default:
            floorWorkRate = 0;
            floorWorkName = "";
            break;
    }
    return { floorWorkRate: floorWorkRate, floorWorkName: floorWorkName };
}

function hasLivingFloorEstimateWorks(sm) {
    if (!sm) return false;
    if (getLivingFloorFinishVariants(sm).length) return true;
    return getLivingAdditionalFloors(sm).some(function (m) {
        return m.type === 'screed' || m.type === 'selfLeveling' || m.type === 'skirting';
    });
}

function buildLivingFloorsEstimateItems(sm) {
    const items = [];
    const totalPrimer = computeTotalLivingFloorPrimerSqm(sm);
    if (totalPrimer > 0) pushFloorPrimerLine(items, totalPrimer);

    getLivingFloorFinishVariants(sm).forEach(function (f) {
        const row = floorFinishWorkRow(f.type);
        const a = parseAreaStringToSqm(f.area) || 0;
        if (row.floorWorkRate > 0 && a > 0) {
            items.push({
                name: row.floorWorkName,
                rate: row.floorWorkRate,
                quantity: a.toFixed(1),
                unit: "кв.м.",
                total: (a * row.floorWorkRate).toFixed(1)
            });
            if (f.type === 'tile' || f.type === 'porcelain' || f.type === 'mosaic') {
                pushCementGroutForTileType(items, f.type, a);
            }
        }
    });

    return items;
}

function getBathroomFloorFinishVariants(sm) {
    if (!sm) return [];
    if (sm.bathroomFloorsVariants && sm.bathroomFloorsVariants.length) return sm.bathroomFloorsVariants;
    if (sm.bathroomFloors) return [sm.bathroomFloors];
    return [];
}

function computeTotalBathroomFloorPrimerSqm(sm) {
    if (!sm) return 0;
    let total = 0;
    getBathroomFloorFinishVariants(sm).forEach(function (f) {
        const sq = parseAreaStringToSqm(f.area);
        if (sq != null && sq > 0) total += sq;
    });
    (sm.additionalBathroomFloors || []).forEach(function (m) {
        if (m.type === 'screed' || m.type === 'selfLeveling') {
            const sq = parseAreaStringToSqm(m.area);
            if (sq != null && sq > 0) total += sq;
        }
    });
    return total;
}

function bathroomFloorFinishWorkRow(type) {
    let floorTileRate = ESTIMATE_RATE_TILE_CERAMIC_SQM;
    let floorTileName = "Укладка на пол стандартной плитки";
    if (type === 'mosaic') {
        floorTileRate = 3000;
        floorTileName = "Укладка мозаики на пол";
    } else if (type === 'porcelain') {
        floorTileRate = ESTIMATE_RATE_TILE_PORCELAIN_SQM;
        floorTileName = "Укладка керамогранита на пол";
    }
    return { floorTileRate: floorTileRate, floorTileName: floorTileName };
}

function hasBathroomFloorFinishWorks(sm) {
    return getBathroomFloorFinishVariants(sm).length > 0
        || (sm.additionalBathroomFloors || []).some(function (m) {
            return m.type === 'screed' || m.type === 'selfLeveling';
        });
}

function buildBathroomFloorEstimateItems(sm) {
    const items = [];
    const totalPrimer = computeTotalBathroomFloorPrimerSqm(sm);
    if (totalPrimer > 0) pushFloorPrimerLine(items, totalPrimer);

    getBathroomFloorFinishVariants(sm).forEach(function (f) {
        const row = bathroomFloorFinishWorkRow(f.type);
        const a = parseAreaStringToSqm(f.area) || 0;
        if (row.floorTileRate > 0 && a > 0) {
            items.push({
                name: row.floorTileName,
                rate: row.floorTileRate,
                quantity: a.toFixed(1),
                unit: "кв.м.",
                total: (a * row.floorTileRate).toFixed(1)
            });
            if (f.type === 'porcelain' || f.type === 'ceramic' || f.type === 'tile' || f.type === 'mosaic') {
                pushCementGroutForTileType(items, f.type, a);
            }
        }
    });

    (sm.additionalBathroomFloors || []).forEach(function (additionalMaterial) {
        let additionalWorkRate = 0;
        let additionalWorkName = "";
        switch (additionalMaterial.type) {
            case 'screed':
                additionalWorkRate = 950;
                additionalWorkName = "Стяжка под плитку";
                break;
            case 'selfLeveling':
                additionalWorkRate = selfLevelingWorkRatePerSqm(additionalMaterial.thicknessMm);
                additionalWorkName = "Наливной пол";
                break;
            default:
                additionalWorkRate = 0;
                additionalWorkName = "";
                break;
        }
        if (additionalWorkRate <= 0) return;
        const additionalArea = parseAreaStringToSqm(additionalMaterial.area) || 0;
        if (additionalArea <= 0) return;
        items.push({
            name: additionalWorkName,
            rate: additionalWorkRate,
            quantity: additionalArea.toFixed(1),
            unit: "кв.м.",
            total: (additionalArea * additionalWorkRate).toFixed(1)
        });
    });

    return items;
}

function getBathroomWallTileVariants(sm) {
    if (!sm) return [];
    if (sm.wallTileVariants && sm.wallTileVariants.length) return sm.wallTileVariants;
    if (sm.wallTile) return [sm.wallTile];
    return [];
}

function computeTotalBathroomWallPrimerSqm(sm) {
    if (!sm) return 0;
    let total = 0;
    (sm.additionalWallTile || []).forEach(function (m) {
        if (m.type === 'plaster') {
            const sq = parseAreaStringToSqm(m.area);
            if (sq != null && sq > 0) total += sq;
        }
    });
    getBathroomWallTileVariants(sm).forEach(function (wt) {
        const sq = parseAreaStringToSqm(wt.area);
        if (sq != null && sq > 0) total += sq;
    });
    return total;
}

function bathroomWallTileWorkRow(type) {
    let wallTileRate = ESTIMATE_RATE_TILE_CERAMIC_SQM;
    let wallTileName = "Облицовка стен стандартной плиткой";
    if (type === 'mosaic') {
        wallTileRate = 3000;
        wallTileName = "Облицовка стен мозаикой";
    } else if (type === 'porcelain') {
        wallTileRate = ESTIMATE_RATE_TILE_PORCELAIN_SQM;
        wallTileName = "Облицовка стен керамогранитом";
    }
    return { wallTileRate: wallTileRate, wallTileName: wallTileName };
}

function hasBathroomWallEstimateWorks(sm) {
    if (!sm) return false;
    if (getBathroomWallTileVariants(sm).length) return true;
    return (sm.additionalWallTile || []).some(function (m) {
        return m.type === 'plaster'
            || (m.type === 'box' && (parseInt(String(m.quantity), 10) || 0) > 0)
            || m.type === 'tile45Cut';
    });
}

function buildBathroomWallsEstimateItems(sm) {
    const items = [];
    const hasWallTilePlaster = (sm.additionalWallTile || []).some(function (m) { return m.type === 'plaster'; });
    const totalPrimer = computeTotalBathroomWallPrimerSqm(sm);
    if (totalPrimer > 0) pushBathroomWallPrimerLine(items, totalPrimer);

    if (hasWallTilePlaster) {
        const plWt = (sm.additionalWallTile || []).find(function (m) { return m.type === 'plaster'; });
        const plasterAreaSu = plWt && plWt.area ? (parseAreaStringToSqm(plWt.area) || 0) : 0;
        if (plasterAreaSu > 0) {
            items.push({
                name: "Штукатурка стен под плитку",
                rate: 550,
                quantity: plasterAreaSu.toFixed(1),
                unit: "кв.м.",
                total: (plasterAreaSu * 550).toFixed(1)
            });
        }
    }

    const wallTileVariants = getBathroomWallTileVariants(sm);
    if (wallTileVariants.length > 0) {
        const hasBathtub = sm.plumbing && sm.plumbing.some(function (s) { return s.type === 'bathtub'; });
        if (hasBathtub || hasPorcelainTrayScope(sm)) {
            items.push({
                name: "Гидроизоляция стен",
                rate: 300,
                quantity: 8,
                unit: "кв.м.",
                total: (8 * 300).toFixed(1)
            });
        }

        wallTileVariants.forEach(function (wt) {
            const a = parseAreaStringToSqm(wt.area) || 0;
            if (a <= 0) return;
            const row = bathroomWallTileWorkRow(wt.type);
            items.push({
                name: row.wallTileName,
                rate: row.wallTileRate,
                quantity: a.toFixed(1),
                unit: "кв.м.",
                total: (a * row.wallTileRate).toFixed(1)
            });
            if (wt.type === 'porcelain' || wt.type === 'ceramic' || wt.type === 'tile' || wt.type === 'mosaic') {
                pushCementGroutForTileType(items, wt.type, a);
            }
        });
    }

    (sm.additionalWallTile || []).forEach(function (additionalMaterial) {
        if (additionalMaterial.type === 'plaster') return;
        if (additionalMaterial.type === 'box') {
            const boxQty = additionalMaterial.quantity || 0;
            if (boxQty > 0) {
                items.push({
                    name: "Устройство короба",
                    rate: 1900,
                    quantity: boxQty,
                    unit: "шт.",
                    total: (boxQty * 1900).toFixed(1)
                });
            }
        } else if (additionalMaterial.type === 'tile45Cut') {
            const tile45Qty = parseFloat(additionalMaterial.quantity) || 0;
            if (tile45Qty > 0) {
                items.push({
                    name: "Запил плитки под 45°",
                    rate: 1200,
                    quantity: tile45Qty,
                    unit: "п.м.",
                    total: (tile45Qty * 1200).toFixed(1)
                });
            }
        }
    });

    const hasInstallation = sm.plumbing && sm.plumbing.some(function (s) { return s.type === 'installation'; });
    if (hasInstallation) {
        const installationCount = sm.plumbing.reduce(function (sum, s) {
            return s.type === 'installation' ? sum + (parseInt(s.quantity, 10) || 1) : sum;
        }, 0);
        items.push({
            name: "Устройство Коробов из гипсокартона(инсталяция)",
            rate: 1900,
            quantity: installationCount,
            unit: "шт.",
            total: (installationCount * 1900).toFixed(1)
        });
    }

    return items;
}

function wallFinishUsesOnePrimerLayer(type) {
    return type === 'paint' || type === 'wallpaper' || type === 'decorative'
        || type === 'tile' || type === 'porcelain';
}

function getWallPuttyAreaSqm(additionalWalls) {
    if (!additionalWalls || !additionalWalls.length) return 0;
    let sum = 0;
    additionalWalls.forEach(function (m) {
        if (!isWallPuttySpravType(m.type)) return;
        const sq = parseAreaStringToSqm(m.area);
        if (sq != null && sq > 0) sum += sq;
    });
    return sum;
}

function getWallPlasterAreaSqm(additionalWalls) {
    if (!additionalWalls || !additionalWalls.length) return 0;
    const pl = additionalWalls.find(function (m) { return m.type === 'plaster'; });
    if (!pl) return 0;
    const sq = parseAreaStringToSqm(pl.area);
    return sq != null && sq > 0 ? sq : 0;
}

/** Слои грунтовки жилых стен: +1 штукатурка, +1 шпаклёвка, +1 чистовая отделка (суммируются в одну строку). */
function wallLivingPrimerLayerCount(hasPlaster, hasPutty, hasFinish) {
    let layers = 0;
    if (hasPlaster) layers += 1;
    if (hasPutty) layers += 1;
    if (hasFinish) layers += 1;
    return layers;
}

/** @deprecated — используйте computeTotalWallLivingPrimerSqm + pushWallAcrylicPrimerLine */
function pushWallLivingFinishPrimer(items, areaSq) {
    const sq = parseFloat(areaSq) || 0;
    if (sq > 0) pushWallAcrylicPrimerLine(items, sq);
}

function wallLivingPrimerAreaSqm(wallArea, livingPrimerArea, plasterArea, puttyArea, hasFinish) {
    if (hasFinish || plasterArea > 0) {
        if (livingPrimerArea > 0) return livingPrimerArea;
        if (wallArea > 0) return wallArea;
        return Math.max(plasterArea, puttyArea);
    }
    if (puttyArea > 0) return puttyArea;
    if (plasterArea > 0) return plasterArea;
    return Math.max(wallArea, livingPrimerArea, plasterArea, puttyArea);
}

function computeTotalWallLivingSandingSqm(sm) {
    return getWallPuttyAreaSqm(sm && sm.additionalWalls);
}

function pushWallSandingLine(items, totalAreaSq) {
    const sq = parseFloat(totalAreaSq) || 0;
    if (sq <= 0) return;
    items.push({
        name: 'Шлифовка стен',
        rate: 90,
        quantity: sq.toFixed(1),
        unit: 'кв.м.',
        total: (sq * 90).toFixed(1)
    });
}

function pushWallPuttyEstimateItem(items, areaSq, puttyType) {
    const sq = parseFloat(areaSq) || 0;
    if (sq <= 0 || !isWallPuttySpravType(puttyType)) return;
    const layers = wallPuttyLayersForType(puttyType);
    items.push({
        name: wallPuttyEstimateLabel(puttyType),
        rate: 180,
        quantity: (sq * layers).toFixed(1),
        unit: 'кв.м.',
        total: (sq * layers * 180).toFixed(1)
    });
}

/** @deprecated — используйте pushWallPuttyEstimateItem + pushWallSandingLine с суммарной площадью */
function pushWallPuttyAndSandingEstimateItems(items, areaSq, puttyType) {
    pushWallPuttyEstimateItem(items, areaSq, puttyType);
    pushWallSandingLine(items, areaSq);
}

/** Кабели проводки по потолку (на отрез, этап 3). */
const CEILING_WIRING_CABLE_SKUS = ['81933629', '81933623', '81933630'];

function clearSpravSelectedMaterials() {
    selectedMaterials.walls = null;
    delete selectedMaterials.wallsVariants;
    delete selectedMaterials.floorsVariants;
    delete selectedMaterials.bathroomFloorsVariants;
    delete selectedMaterials.wallTileVariants;
    delete selectedMaterials.ceilingCableM;
    selectedMaterials.floors = null;
    selectedMaterials.bathroomFloors = null;
    selectedMaterials.ceilings = [];
    selectedMaterials.electrical = [];
    selectedMaterials.plumbing = [];
    selectedMaterials.wallTile = null;
    selectedMaterials.lighting = [];
    selectedMaterials.windowsDoors = [];
    selectedMaterials.additionalFloors = [];
    selectedMaterials.additionalWalls = [];
    selectedMaterials.additionalWallTile = [];
    selectedMaterials.additionalBathroomFloors = [];
    selectedMaterials.demolition = [];
    selectedMaterials.partitions = [];
    selectedMaterials.bathroomPorcelainTrayEnabled = false;
    selectedMaterials.bathroomPorcelainTraySqm = 0;
    delete selectedMaterials.wallPuttyAreaM2;
    delete selectedMaterials.wallModalAreasUserTouched;
    delete selectedMaterials.breakerExtraBySku;
    selectedMaterials.stage4GeneralFix = false;
}

function mergePlanOutputOverridesIntoCalc(lc, overrides) {
    if (!overrides || typeof overrides !== 'object' || !lc) return;
    function num(v) {
        if (v === '' || v === null || v === undefined) return null;
        const n = parseFloat(String(v).replace(',', '.'));
        if (typeof n !== 'number' || isNaN(n) || n < 0) return null;
        return Math.round(n * 10) / 10;
    }
    if (!lc.materials) lc.materials = {};
    const m = lc.materials;
    const tw = num(overrides.totalWall);
    if (tw !== null) lc.totalWallArea = tw;
    const lf = num(overrides.livingFloor);
    if (lf !== null) {
        m.laminate = lf;
        m.livingFloor = lf;
    }
    const ce = num(overrides.ceiling);
    if (ce !== null) {
        lc.totalCeilingArea = ce;
        m.ceiling = ce;
    }
    const wt = num(overrides.wallTile);
    if (wt !== null) m.wallTile = wt;
    const ft = num(overrides.floorTile);
    if (ft !== null) m.floorTile = ft;
    const ta = num(overrides.totalApt);
    if (ta !== null) {
        lc.totalApartmentArea = ta;
        lc.totalFloorArea = ta;
    }
}

function parseAreaStringToSqm(str) {
    if (str == null || str === '') return null;
    const n = parseFloat(String(str).replace(/[^\d.,-]/g, '').replace(',', '.'));
    return isNaN(n) || n <= 0 ? null : n;
}

const MUSOR_BAGS_PER_PACK = 10;

function isCeramicOrPorcelainTileType(t) {
    return t === 'tile' || t === 'porcelain' || t === 'ceramic';
}

function isTileLayingType(t) {
    return t === 'tile' || t === 'porcelain' || t === 'ceramic' || t === 'mosaic';
}

/** Укладка плитки/керамогранита/мозаики или фартук — без штукатурки под плитку, короба, запила 45°. */
function hasTileWorkScope(sm) {
    if (!sm) return false;

    function variantsHaveTile(arr) {
        return arr && arr.some(function (m) { return m && isTileLayingType(m.type); });
    }

    if (variantsHaveTile(sm.floorsVariants)) return true;
    if (sm.floors && isTileLayingType(sm.floors.type)) return true;

    if (getBathroomFloorFinishVariants(sm).some(function (f) { return f && isTileLayingType(f.type); })) return true;

    if (getBathroomWallTileVariants(sm).some(function (w) { return w && isTileLayingType(w.type); })) return true;

    if (variantsHaveTile(sm.wallsVariants)) return true;
    if (sm.walls && isTileLayingType(sm.walls.type)) return true;

    if ((sm.additionalWalls || []).some(function (m) { return m && m.type === 'ceramicGraniteApron'; })) return true;

    return false;
}

/** Керамогранит в смете: жилые стены/пол, санузел, фартук, поддон — без монтажной пены и пистолета (этап 8). */
function hasPorcelainTileScopeInSm(sm) {
    if (!sm) return false;
    if (sm.bathroomPorcelainTrayEnabled) return true;
    function variantHasPorcelain(arr) {
        return arr && arr.some(function (v) { return v && v.type === 'porcelain'; });
    }
    if (sm.floors && sm.floors.type === 'porcelain') return true;
    if (variantHasPorcelain(sm.floorsVariants)) return true;
    if (sm.walls && sm.walls.type === 'porcelain') return true;
    if (variantHasPorcelain(sm.wallsVariants)) return true;
    if (sm.bathroomFloors && sm.bathroomFloors.type === 'porcelain') return true;
    if (variantHasPorcelain(sm.bathroomFloorsVariants)) return true;
    if (sm.wallTile && sm.wallTile.type === 'porcelain') return true;
    if (variantHasPorcelain(sm.wallTileVariants)) return true;
    if ((sm.additionalWalls || []).some(function (m) { return m && m.type === 'ceramicGraniteApron'; })) return true;
    return false;
}

function shouldOmitStage8FoamGun(sm, mosaicSqmVal) {
    if ((parseFloat(mosaicSqmVal) || 0) > 0) return true;
    if (hasPorcelainTileScopeInSm(sm)) return true;
    if (hasWallpaperWallScope(sm)) return true;
    if (hasDecorativeWallScope(sm)) return true;
    return false;
}

/** Сумма м² по variants с укладкой плитки; если площади не заданы — fallbackSqm при наличии таких variants. */
function sumTileLayingAreaFromVariants(variants, fallbackSqm) {
    if (!variants || !variants.length) return 0;
    let total = 0;
    let hasTile = false;
    variants.forEach(function (v) {
        if (!v || !isTileLayingType(v.type)) return;
        hasTile = true;
        const sq = v.area ? parseAreaStringToSqm(v.area) : null;
        if (sq != null && sq > 0) total += sq;
    });
    if (!hasTile) return 0;
    if (total > 0) return total;
    return fallbackSqm > 0 ? fallbackSqm : 0;
}

/** Площадь керамической плитки и керамогранита (без мозаики) — жилые стены/пол, санузел, фартук. */
function ceramicPorcelainTileAreaSqm(sm, calc) {
    if (!sm) return 0;
    let total = 0;
    const lam = (calc && calc.materials && calc.materials.laminate) || 0;
    const floorTile = (calc && calc.materials && calc.materials.floorTile) || 0;
    const wallTile = (calc && calc.materials && calc.materials.wallTile) || 0;
    const wallMat = (calc && calc.totalWallArea) || 0;

    function areaOf(m, fallback) {
        if (!m) return 0;
        const sq = m.area ? parseAreaStringToSqm(m.area) : null;
        if (sq != null && sq > 0) return sq;
        return fallback > 0 ? fallback : 0;
    }

    if (sm.floors && isCeramicOrPorcelainTileType(sm.floors.type)) {
        total += areaOf(sm.floors, lam);
    }
    if (sm.bathroomFloors && isCeramicOrPorcelainTileType(sm.bathroomFloors.type)) {
        total += areaOf(sm.bathroomFloors, floorTile);
    }
    if (sm.wallTile && isCeramicOrPorcelainTileType(sm.wallTile.type)) {
        total += areaOf(sm.wallTile, wallTile);
    }
    if (sm.wallsVariants && sm.wallsVariants.length) {
        sm.wallsVariants.forEach(function (v) {
            if (v && isCeramicOrPorcelainTileType(v.type)) total += areaOf(v, 0);
        });
        if (total <= 0 && sm.wallsVariants.some(function (v) { return v && isCeramicOrPorcelainTileType(v.type); })) {
            total += wallMat;
        }
    } else if (sm.walls && isCeramicOrPorcelainTileType(sm.walls.type)) {
        total += areaOf(sm.walls, wallMat);
    }
    (sm.additionalWalls || []).forEach(function (m) {
        if (m && m.type === 'ceramicGraniteApron') total += areaOf(m, 0);
    });
    return total;
}

/** Площадь мозаики — стены/пол санузла, пол жилых комнат. */
function mosaicTileAreaSqm(sm, calc) {
    if (!sm) return 0;
    const lam = (calc && calc.materials && calc.materials.laminate) || 0;
    const floorTile = (calc && calc.materials && calc.materials.floorTile) || 0;
    const wallTile = (calc && calc.materials && calc.materials.wallTile) || 0;

    let livingFloorTileArea = 0;
    if (sm.floorsVariants && sm.floorsVariants.length) {
        livingFloorTileArea = sumTileLayingAreaFromVariants(sm.floorsVariants, lam);
    } else if (sm.floors && isTileLayingType(sm.floors.type)) {
        const sq = sm.floors.area ? parseAreaStringToSqm(sm.floors.area) : null;
        livingFloorTileArea = (sq != null && sq > 0) ? sq : lam;
    }

    let total = 0;
    getBathroomWallTileVariants(sm).forEach(function (wt) {
        if (!wt || !isTileLayingType(wt.type) || wt.type !== 'mosaic') return;
        const sq = wt.area ? parseAreaStringToSqm(wt.area) : null;
        total += (sq != null && sq > 0) ? sq : wallTile;
    });
    getBathroomFloorFinishVariants(sm).forEach(function (bf) {
        if (!bf || !isTileLayingType(bf.type) || bf.type !== 'mosaic') return;
        const sq = bf.area ? parseAreaStringToSqm(bf.area) : null;
        total += (sq != null && sq > 0) ? sq : floorTile;
    });
    if (sm.floorsVariants && sm.floorsVariants.length) {
        sm.floorsVariants.forEach(function (f) {
            if (!f || !isTileLayingType(f.type) || f.type !== 'mosaic') return;
            const sq = f.area ? parseAreaStringToSqm(f.area) : null;
            total += (sq != null && sq > 0) ? sq : livingFloorTileArea;
        });
    } else if (sm.floors && isTileLayingType(sm.floors.type) && sm.floors.type === 'mosaic') {
        total += livingFloorTileArea;
    }
    return total;
}

/** Мешки под мусор при укладке керамики/керамогранита: ⌈S / 5⌉ шт. */
function tileMusorBagsFromAreaSqm(sqm) {
    if (!(sqm > 0)) return 0;
    return Math.ceil(sqm / 5);
}

/** Клей для мозаики Litoplus K55 (11169661): 1,95 кг/м², мешок 25 кг → S×1,95/25 (округление в add). */
const MOSAIC_GLUE_KG_PER_SQM = 1.95;
const MOSAIC_GLUE_BAG_KG = 25;

function mosaicGlueBagsFromSqm(sqm) {
    if (!(sqm > 0)) return 0;
    return sqm * MOSAIC_GLUE_KG_PER_SQM / MOSAIC_GLUE_BAG_KG;
}

/** Мешки под мусор при укладке мозаики: max(1, ⌈S / 20⌉). */
function mosaicMusorBagsFromSqm(sqm) {
    return musorBagsMinOnePerSqm(sqm, 20);
}

/** Мешки 17968499: max(1, ⌈S / sqmPerBag⌉). */
function musorBagsMinOnePerSqm(sqm, sqmPerBag) {
    if (!(sqm > 0) || !(sqmPerBag > 0)) return 0;
    return Math.max(1, Math.ceil(sqm / sqmPerBag));
}

/** Губки шлифовальные P120/P180: ⌈S / 100⌉ шт. каждой — только при шпаклёвке. */
function addPuttySandingSponges(addFn, stageNum, sqm) {
    if (!(sqm > 0) || !addFn) return;
    addFn(stageNum, 18783904, sqm / 100);
    addFn(stageNum, 18782696, sqm / 100);
}

function additionalFloorItemSqm(m) {
    if (!m) return 0;
    const sq = m.area ? parseAreaStringToSqm(m.area) : null;
    if (sq != null && sq > 0) return sq;
    const n = parseFloat(String(m.area || '').replace(' м²', '').replace(',', '.'));
    return !isNaN(n) && n > 0 ? n : 0;
}

/** Мешки под мусор: штукатурка/стяжка — max(1, ⌈S/10⌉); наливной — max(1, ⌈S/20⌉); шпаклёвка — max(1, ⌈S/100⌉). */
function computePlasterScreedSelfLevelMusorBags(sm) {
    if (!sm) return 0;
    let bags = 0;
    (sm.additionalWalls || []).forEach(function (m) {
        if (!m || m.type !== 'plaster') return;
        const sq = additionalFloorItemSqm(m);
        if (sq > 0) bags += musorBagsMinOnePerSqm(sq, 10);
    });
    (sm.additionalWallTile || []).forEach(function (m) {
        if (!m || m.type !== 'plaster') return;
        const sq = additionalFloorItemSqm(m);
        if (sq > 0) bags += musorBagsMinOnePerSqm(sq, 10);
    });
    (sm.ceilings || []).forEach(function (c) {
        if (!c || c.type !== 'plasterCeiling') return;
        const sq = additionalFloorItemSqm(c);
        if (sq > 0) bags += musorBagsMinOnePerSqm(sq, 10);
    });
    (sm.additionalFloors || []).forEach(function (m) {
        if (!m) return;
        const sq = additionalFloorItemSqm(m);
        if (sq <= 0) return;
        if (m.type === 'screed') bags += musorBagsMinOnePerSqm(sq, 10);
        if (m.type === 'selfLeveling') bags += musorBagsMinOnePerSqm(sq, 20);
    });
    (sm.additionalBathroomFloors || []).forEach(function (m) {
        if (!m) return;
        const sq = additionalFloorItemSqm(m);
        if (sq <= 0) return;
        if (m.type === 'screed') bags += musorBagsMinOnePerSqm(sq, 10);
        if (m.type === 'selfLeveling') bags += musorBagsMinOnePerSqm(sq, 20);
    });
    let puttySqm = getWallPuttyAreaSqm(sm.additionalWalls);
    if (puttySqm <= 0 && sm.wallPuttyAreaM2 > 0) puttySqm = sm.wallPuttyAreaM2;
    (sm.ceilings || []).forEach(function (c) {
        if (!c || c.type !== 'puttyCeiling') return;
        puttySqm += additionalFloorItemSqm(c);
    });
    if (puttySqm > 0) bags += musorBagsMinOnePerSqm(puttySqm, 100);
    return bags;
}

/** Поддон из керамогранита: bf-tray-porcelain или plumb-tray. */
function hasPorcelainTrayScope(sm) {
    if (!sm) return false;
    if (sm.bathroomPorcelainTrayEnabled) return true;
    return (sm.plumbing || []).some(function (s) { return s && s.type === 'tray'; });
}

/** Мешки 17968499: поддон из керамогранита — 1 шт. при выборе. */
function computePorcelainTrayMusorBags(sm) {
    return hasPorcelainTrayScope(sm) ? 1 : 0;
}

/** Мешки 17968499 при укладке жилых полов: ламинат/паркет/ПВХ — max(1, ⌈S/10⌉); линолеум/ковролин — max(1, ⌈S/20⌉). */
function livingFloorMusorBagsFromSqm(floorType, sqm) {
    if (!(sqm > 0) || !floorType) return 0;
    if (floorType === 'laminate' || floorType === 'parquet' || floorType === 'pvc') {
        return Math.max(1, Math.ceil(sqm / 10));
    }
    if (floorType === 'linoleum' || floorType === 'carpet') {
        return Math.max(1, Math.ceil(sqm / 20));
    }
    return 0;
}

function livingFloorVariantSqm(f, laminateFallback) {
    if (!f) return 0;
    const sq = f.area ? parseAreaStringToSqm(f.area) : null;
    if (sq != null && sq > 0) return sq;
    return laminateFallback > 0 ? laminateFallback : 0;
}

/** Площадь м² доп. позиции пола (стяжка, наливной); плинтус — 0. */
function livingAdditionalFloorAreaSqm(m) {
    if (!m || m.type === 'skirting') return 0;
    const sq = m.area ? parseAreaStringToSqm(m.area) : null;
    if (sq != null && sq > 0) return sq;
    const n = parseFloat(String(m.area || '').replace(' м²', '').replace(',', '.'));
    return !isNaN(n) && n > 0 ? n : 0;
}

/** Этап 8–9: лезвия, подложка, клей — по каждому выбранному жилому покрытию (не только floorsVariants[0]). */
function addLivingFloorCoveringBasketItems(add, sm, laminateFallback) {
    if (!sm || typeof add !== 'function') return;
    let carpetPvcConsumableAdded = false;
    getLivingFloorFinishVariants(sm).forEach(function (f) {
        if (!f || !f.type || isTileLayingType(f.type)) return;
        const sq = livingFloorVariantSqm(f, laminateFallback);
        if (!(sq > 0)) return;
        if (f.type === 'laminate' || f.type === 'parquet' || f.type === 'carpet' || f.type === 'pvc' || f.type === 'linoleum') {
            add(8, 82285188, sq / 50);
        }
        if (f.type === 'laminate' || f.type === 'parquet') {
            add(9, 89421413, sq / 5.04);
        } else if (f.type === 'carpet' || f.type === 'pvc') {
            add(9, 17750553, sq / 35);
            if (!carpetPvcConsumableAdded) {
                add(9, 15087997, 1);
                carpetPvcConsumableAdded = true;
            }
        }
    });
}

/** Сумма мешков 17968499 (шт.) по выбранным жилым напольным покрытиям (не плитка). */
function computeLivingFloorFinishMusorBags(sm, calc) {
    if (!sm) return 0;
    const lamFallback = (calc && calc.materials && calc.materials.laminate) || 0;
    let bags = 0;
    const variants = getLivingFloorFinishVariants(sm);
    if (variants.length) {
        variants.forEach(function (f) {
            if (!f || !f.type) return;
            const sq = livingFloorVariantSqm(f, lamFallback);
            bags += livingFloorMusorBagsFromSqm(f.type, sq);
        });
    } else if (sm.floors && sm.floors.type) {
        const sq = livingFloorVariantSqm(sm.floors, lamFallback);
        bags += livingFloorMusorBagsFromSqm(sm.floors.type, sq);
    }
    return bags;
}

/** Мешки 17968499 при демонтаже (шт.): линолеум — 5/10 м²; обои/краска — ⌈S/10⌉; стена/пол — max(1, ⌈S/6⌉)×10. */
function demolitionMusorBagsFromSqm(demoType, sq) {
    if (!(sq > 0)) return 0;
    if (demoType === 'demoLinoleum') return Math.ceil((sq * 5) / 10);
    if (demoType === 'demoWallpaper' || demoType === 'demoPaint') return Math.ceil(sq / 10);
    return Math.max(1, Math.ceil(sq / 6)) * MUSOR_BAGS_PER_PACK;
}

/** Упаковки 17968499 (10 шт.) для корзины при демонтаже. */
function demolitionMusorBagPacksFromSqm(demoType, sq) {
    if (!(sq > 0)) return 0;
    if (demoType === 'demoLinoleum') return Math.ceil(Math.ceil((sq * 5) / 10) / MUSOR_BAGS_PER_PACK);
    if (demoType === 'demoWallpaper' || demoType === 'demoPaint') {
        return Math.ceil(Math.ceil(sq / 10) / MUSOR_BAGS_PER_PACK);
    }
    return Math.max(1, Math.ceil(sq / 6));
}

const LIGHT_DEMOLITION_TYPES = { demoLinoleum: 1, demoWallpaper: 1, demoPaint: 1 };

/** Ёмкость КЭС 60 л (86759162) — при демонтаже стен/пола; не при одних линолеум/обои/краска. */
function demolitionNeedsKesContainer(demolitionArr) {
    if (!demolitionArr || !demolitionArr.length) return false;
    return demolitionArr.some(function (job) {
        return job && job.type && !LIGHT_DEMOLITION_TYPES[job.type];
    });
}

/** Итого мешков 17968499 для строки сметы «Вынос мусора…» (шт., не упаковки). */
function computeMusorBagCount(sm, calc) {
    if (!sm) return 0;
    let bags = 0;
    (sm.demolition || []).forEach(function (job) {
        if (!job || job.quantity == null) return;
        const sq = typeof job.quantity === 'number'
            ? job.quantity
            : parseAreaStringToSqm(String(job.quantity));
        if (sq == null || sq <= 0) return;
        bags += demolitionMusorBagsFromSqm(job.type, sq);
    });
    let partitionSqm = 0;
    (sm.partitions || []).forEach(function (p) {
        if (!p || p.quantity == null) return;
        const sq = parseFloat(String(p.quantity).replace(/\s/g, '').replace(',', '.'));
        if (!isNaN(sq) && sq > 0) partitionSqm += sq;
    });
    if (partitionSqm > 0) {
        bags += Math.max(1, Math.ceil(partitionSqm / 30)) * MUSOR_BAGS_PER_PACK;
    }
    if (sm.walls && sm.walls.type === 'gypsumFrame') {
        const gSq = parseAreaStringToSqm(sm.walls.area) || ((calc && calc.totalWallArea) || 0);
        if (gSq > 0) bags += Math.ceil(gSq / 30) * MUSOR_BAGS_PER_PACK;
    }
    bags += tileMusorBagsFromAreaSqm(ceramicPorcelainTileAreaSqm(sm, calc));
    bags += mosaicMusorBagsFromSqm(mosaicTileAreaSqm(sm, calc));
    bags += computeLivingFloorFinishMusorBags(sm, calc);
    bags += computePlasterScreedSelfLevelMusorBags(sm);
    bags += computePorcelainTrayMusorBags(sm);
    if (sm.ceilings && sm.ceilings.length) {
        sm.ceilings.forEach(function (c) {
            if (!c || c.type !== 'armstrong' || !c.area) return;
            const sq = parseAreaStringToSqm(c.area);
            if (sq != null && sq > 0) bags += Math.ceil(sq / 10);
        });
    }
    return bags;
}

function escapeHtmlText(s) {
    if (s == null || s === '') return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function sanitizeEstimateFilenamePart(s) {
    if (s == null || s === '') return '';
    return String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().substring(0, 80);
}

/** Параметр товара в URL корзины Лемана: для части позиций нужен id карточки (хвост URL /product/...-ID/), иначе корзина может не подтянуть позицию. Артикул в смете не меняем. */
function lemanaBasketProductParamFromSku(sku) {
    const map = { '605125': '87553787' }; // диск Rage по керамограниту — арт. 605125, id карточки 87553787
    const k = String(sku);
    return map[k] || k;
}

/** Каталог керамогранита — для ссылок в блоке материалов при type === porcelain (жилые стены/пол, санузел); не путать с nastennaya/napolnaya плиткой. */
const LEMANA_CATALOG_KERAMOGRANIT = 'https://novosibirsk.lemanapro.ru/catalogue/keramogranit/';
const LEMANA_CATALOG_SKIRTING = 'https://novosibirsk.lemanapro.ru/catalogue/napolnye-plintusy/';
const LEMANA_CATALOG_TILE_GROUT = 'https://novosibirsk.lemanapro.ru/catalogue/zatirki-dlya-shvov-plitki/';
const MATERIAL_LINKS = {
            walls: { wallpaper: 'https://novosibirsk.lemanapro.ru/catalogue/oboi-dlya-sten-i-potolka/', paint: 'https://novosibirsk.lemanapro.ru/catalogue/kraski-dlya-sten-i-potolkov/', decorative: 'https://novosibirsk.lemanapro.ru/catalogue/fasadnye-shtukaturki/', panels: 'https://novosibirsk.lemanapro.ru/catalogue/paneli-pvh/', plaster: 'https://novosibirsk.lemanapro.ru/catalogue/dekorativnye-shtukaturki/', gypsumFrame: 'https://novosibirsk.lemanapro.ru/catalogue/gipsokarton/', tile: 'https://novosibirsk.lemanapro.ru/catalogue/nastennaya-plitka/', porcelain: LEMANA_CATALOG_KERAMOGRANIT },
            floors: { laminate: 'https://novosibirsk.lemanapro.ru/catalogue/laminat/', pvc: 'https://novosibirsk.lemanapro.ru/catalogue/pvh-plitka/', tile: 'https://novosibirsk.lemanapro.ru/catalogue/napolnaya-plitka/', ceramic: 'https://novosibirsk.lemanapro.ru/catalogue/napolnaya-plitka/', porcelain: LEMANA_CATALOG_KERAMOGRANIT, mosaic: 'https://novosibirsk.lemanapro.ru/catalogue/dekorativnaya-mozaika/', parquet: 'https://novosibirsk.lemanapro.ru/catalogue/parketnaya-doska/', carpet: 'https://novosibirsk.lemanapro.ru/catalogue/kovrolin/', linoleum: 'https://novosibirsk.lemanapro.ru/catalogue/linoleum/' },
            ceilings: { stretch: 'https://novosibirsk.lemanapro.ru/catalogue/natyazhnye-potolki/', paintCeiling: 'https://novosibirsk.lemanapro.ru/catalogue/kraski-dlya-sten-i-potolkov/', plasterCeiling: 'https://novosibirsk.lemanapro.ru/catalogue/dekorativnye-shtukaturki/', puttyCeiling: 'https://novosibirsk.lemanapro.ru/catalogue/shpaklevka/', fabric: 'https://novosibirsk.lemanapro.ru/catalogue/natyazhnye-potolki/', armstrong: 'https://novosibirsk.lemanapro.ru/catalogue/podvesnye-potolki/' },
            wallTile: { ceramic: 'https://novosibirsk.lemanapro.ru/catalogue/nastennaya-plitka/', porcelain: LEMANA_CATALOG_KERAMOGRANIT, mosaic: 'https://novosibirsk.lemanapro.ru/catalogue/dekorativnaya-mozaika/' },
            bathroomFloor: { ceramic: 'https://novosibirsk.lemanapro.ru/catalogue/napolnaya-plitka/', porcelain: LEMANA_CATALOG_KERAMOGRANIT, mosaic: 'https://novosibirsk.lemanapro.ru/catalogue/dekorativnaya-mozaika/' },
            electrical: { outlets: 'https://novosibirsk.lemanapro.ru/catalogue/rozetki-i-vyklyuchateli/rozetki/', switches: 'https://novosibirsk.lemanapro.ru/catalogue/rozetki-i-vyklyuchateli/vyklyuchateli/', panel: 'https://novosibirsk.lemanapro.ru/catalogue/elektricheskie-shchity-i-miniboksy/', breakers: 'https://novosibirsk.lemanapro.ru/catalogue/avtomaticheskie-vyklyuchateli/', exhaustfan: 'https://novosibirsk.lemanapro.ru/catalogue/ventilyatory-vytyazhnye/', ceilingWiring: 'https://novosibirsk.lemanapro.ru/catalogue/kabel-i-montazh/', openCableLaying: 'https://novosibirsk.lemanapro.ru/catalogue/kabel-i-montazh/', junctionBoxes: 'https://novosibirsk.lemanapro.ru/catalogue/raspredelitelnye-korobki/', warmFloor: 'https://novosibirsk.lemanapro.ru/catalogue/teplyy-pol/pod-plitku/', thermostat: 'https://novosibirsk.lemanapro.ru/catalogue/teplyy-pol/pod-plitku/', electricTowelWarmer: 'https://novosibirsk.lemanapro.ru/catalogue/polotencesushiteli-elektricheskie/', outletChasing: 'https://novosibirsk.lemanapro.ru/catalogue/podrozetniki/', outletBoxes: 'https://novosibirsk.lemanapro.ru/catalogue/podrozetniki/', electricalChasing: 'https://novosibirsk.lemanapro.ru/catalogue/kabel-i-montazh/', wireLaying: 'https://novosibirsk.lemanapro.ru/catalogue/kabel-i-montazh/' },
            plumbing: { bathtub: 'https://novosibirsk.lemanapro.ru/catalogue/vanny/', sink: 'https://novosibirsk.lemanapro.ru/catalogue/rakoviny-dlya-vannoy/', sinkcabinet: 'https://novosibirsk.lemanapro.ru/catalogue/rakoviny-dlya-vannoy/', toilet: 'https://novosibirsk.lemanapro.ru/catalogue/unitazy-kompakt/', walltoilet: 'https://novosibirsk.lemanapro.ru/catalogue/podvesnye-unitazy/', shower: 'https://novosibirsk.lemanapro.ru/catalogue/dushevye-kabiny-i-shirmy/', tray: 'https://novosibirsk.lemanapro.ru/catalogue/dushevye-trapy/', installation: 'https://novosibirsk.lemanapro.ru/catalogue/komplekt-installyacii-i-unitaza/', heating: 'https://novosibirsk.lemanapro.ru/catalogue/radiatory-otopleniya/', waterheater: 'https://novosibirsk.lemanapro.ru/catalogue/vodonagrevateli/', towelwarmer: 'https://novosibirsk.lemanapro.ru/catalogue/polotencesushiteli-vodyanye/', sololift: 'https://novosibirsk.lemanapro.ru/catalogue/sanitarnye-nasosy/', washingmachine: 'https://novosibirsk.lemanapro.ru/catalogue/stiralnye-mashiny/', dishwasher: 'https://novosibirsk.lemanapro.ru/catalogue/posudomoechnye-mashiny/', kitchensink: 'https://novosibirsk.lemanapro.ru/catalogue/kuhonnye-moyki/', mixers: 'https://novosibirsk.lemanapro.ru/catalogue/smesiteli-dlya-vannoy-komnaty/', bathtubMixer: 'https://novosibirsk.lemanapro.ru/catalogue/smesiteli-dlya-vannoy-komnaty/', sinkMixer: 'https://novosibirsk.lemanapro.ru/catalogue/smesiteli-dlya-vannoy-komnaty/', mirrors: 'https://novosibirsk.lemanapro.ru/catalogue/zerkala-i-polki-v-vannuyu/', glassdoors: 'https://novosibirsk.lemanapro.ru/catalogue/dushevye-kabiny-i-shirmy/', showersystem: 'https://novosibirsk.lemanapro.ru/catalogue/smesiteli-dlya-vannoy-komnaty/' },
            lighting: { spots: 'https://novosibirsk.lemanapro.ru/catalogue/tochechnye-svetilniki/', chandelier: 'https://novosibirsk.lemanapro.ru/catalogue/lyustry/', led: 'https://novosibirsk.lemanapro.ru/catalogue/svetodiodnye-paneli/', track: 'https://novosibirsk.lemanapro.ru/catalogue/trekovye-sistemy-osveshcheniya/', sconce: 'https://novosibirsk.lemanapro.ru/catalogue/bra/', floor: 'https://novosibirsk.lemanapro.ru/catalogue/torshery/' },
            windowsDoors: { windows: 'https://novosibirsk.lemanapro.ru/catalogue/plastikovye-okna/', slopes: 'https://novosibirsk.lemanapro.ru/catalogue/otkosy/', sills: 'https://novosibirsk.lemanapro.ru/catalogue/podokonniki/', openings: 'https://novosibirsk.lemanapro.ru/catalogue/mezhkomnatnye-dveri/', doors: 'https://novosibirsk.lemanapro.ru/catalogue/mezhkomnatnye-dveri/', trim: 'https://novosibirsk.lemanapro.ru/catalogue/nalichniki/', extensions: 'https://novosibirsk.lemanapro.ru/catalogue/dobory-dlya-mezhkomnatnyh-dverey/', locks: 'https://novosibirsk.lemanapro.ru/catalogue/zamki-i-furnitura-dlya-mezhkomnatnyh-dverey/', other: 'https://novosibirsk.lemanapro.ru/catalogue/mezhkomnatnye-dveri/' },
            partitions: { pgb: 'https://novosibirsk.lemanapro.ru/catalogue/plity-pazogrebnevye/', foam: 'https://novosibirsk.lemanapro.ru/catalogue/penobloki-i-stroitelnye-bloki/', brick: 'https://novosibirsk.lemanapro.ru/catalogue/kirpich/', gypsumFrame: 'https://novosibirsk.lemanapro.ru/catalogue/gipsokarton/', gypsumBox: 'https://novosibirsk.lemanapro.ru/catalogue/gipsokarton/' },
            skirting: { plastic: LEMANA_CATALOG_SKIRTING, tile: LEMANA_CATALOG_KERAMOGRANIT }
};

/** Расценки работ «Окна и двери» (₽/шт.) — только монтаж, материалы отдельно. */
const WINDOWS_DOORS_WORK_RATES = {
    windows: { rate: 4500, name: 'Установка / замена окна' },
    slopes: { rate: 2000, name: 'Отделка откосов' },
    sills: { rate: 1800, name: 'Монтаж подоконника' },
    openings: { rate: 800, name: 'Формирование дверного проема' },
    doors: { rate: 4000, name: 'Установка межкомнатной двери' },
    trim: { rate: 1200, name: 'Монтаж наличников' },
    extensions: { rate: 1000, name: 'Монтаж доборов' },
    locks: { rate: 800, name: 'Установка замка / фурнитуры' },
    other: { rate: 1000, name: 'Прочие работы (окна / двери)' }
};

/** Нормы времени графика (ч/шт.) для «Окна и двери». */
const SCHEDULE_WD_HOURS_PER_UNIT = {
    windows: 2.5,
    slopes: 1.5,
    sills: 1,
    openings: 5,
    doors: 3.5,
    trim: 0.8,
    extensions: 1,
    locks: 0.5,
    other: 1
};

function getMaterialLink(category, type) {
    const cat = MATERIAL_LINKS[category];
    if (!cat) return '';
    return (typeof cat === 'string' ? cat : (cat[type] || cat[Object.keys(cat)[0]])) || '';
}

function buildTileGroutDetailLinkHtml() {
    return `<a href="${LEMANA_CATALOG_TILE_GROUT}" target="_blank" rel="noopener noreferrer" class="material-detail-link">Затирка для швов плитки</a>`;
}

function buildMaterialDetailLinkHtml(href, label) {
    if (!label) return '';
    if (!href) return label;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="material-detail-link">${label}</a>`;
}

function formatMaterialAreaKvmLabel(name, areaStr) {
    const areaKvm = areaStr ? String(areaStr).replace(/\s*м²\s*/i, '').trim() : '';
    if (!name) return areaKvm ? areaKvm + ' кв' : '';
    return name + (areaKvm ? ' ' + areaKvm + ' кв' : '');
}

/** В «Выбранных материалах» — только закупаемые позиции; монтаж/штробление/прокладка — только в смете. */
const ELECTRICAL_LABOR_TYPES_IN_MATERIALS_LIST = new Set([
    'junctionBoxes',
    'outletChasing',
    'outletBoxes',
    'electricalChasing',
    'wireLaying',
    'ceilingWiring',
    'openCableLaying'
]);

function buildMaterialsListHtml() {
        
        
        
        let html = '<div class="materials-category-list">';
        
        if (selectedMaterials.walls) {
            const wv = selectedMaterials.wallsVariants && selectedMaterials.wallsVariants.length
                ? selectedMaterials.wallsVariants
                : null;
            const title = 'Стены';
            const detailParts = [];
            if (wv) {
                wv.forEach(function (x) {
                    if (x.name || x.area) {
                        const href = getMaterialLink('walls', x.type);
                        const label = formatMaterialAreaKvmLabel(x.name, x.area);
                        detailParts.push(buildMaterialDetailLinkHtml(href, label));
                    }
                });
            } else {
                const href = getMaterialLink('walls', selectedMaterials.walls.type);
                const label = formatMaterialAreaKvmLabel(selectedMaterials.walls.name, selectedMaterials.walls.area);
                if (label) detailParts.push(buildMaterialDetailLinkHtml(href, label));
            }
            const hasTileOnWalls = wv
                ? wv.some(function (x) { return isCeramicOrPorcelainTileType(x.type); })
                : isCeramicOrPorcelainTileType(selectedMaterials.walls.type);
            if (hasTileOnWalls) {
                detailParts.push(buildTileGroutDetailLinkHtml());
            }
            const details = detailParts.length ? detailParts.join('<br>') : '';
            const card = `<div class="material-category-title">${title}</div>${details ? `<div class="material-category-details">${details}</div>` : ''}`;
            html += `<div class="material-category-card">${card}</div>`;
        } else if (selectedMaterials.additionalWalls && selectedMaterials.additionalWalls.some(m => isWallPuttySpravType(m.type))) {
            const title = 'Стены';
            const detailLines = [];
            selectedMaterials.additionalWalls.forEach(m => {
                if (isWallPuttySpravType(m.type) && m.area) {
                    const puttyLinkType = m.type === 'puttyWallpaper' ? 'wallpaper' : 'paint';
                    const href = getMaterialLink('walls', puttyLinkType);
                    const label = formatMaterialAreaKvmLabel(m.name || '', m.area);
                    detailLines.push(buildMaterialDetailLinkHtml(href, label));
                }
            });
            const details = detailLines.join('<br>');
            const card = `<div class="material-category-title">${title}</div>${details ? `<div class="material-category-details">${details}</div>` : ''}`;
            html += `<div class="material-category-card">${card}</div>`;
        }

        if (selectedMaterials.partitions && selectedMaterials.partitions.length > 0) {
            const lines = selectedMaterials.partitions.map(function (p) {
                const href = getMaterialLink('partitions', p.type);
                let label;
                if (p.unit === 'шт.') {
                    const n = parseInt(String(p.quantity), 10);
                    label = p.name + ': ' + ((!isNaN(n) && n > 0) ? n : 1) + ' шт.';
                } else {
                    label = formatMaterialAreaKvmLabel(p.name, (parseFloat(p.quantity) || 0).toFixed(1) + ' м²');
                }
                return buildMaterialDetailLinkHtml(href, label);
            });
            const card = '<div class="material-category-title">Перегородки</div><div class="material-category-details">' + lines.join('<br>') + '</div>';
            html += `<div class="material-category-card">${card}</div>`;
        }
        
        if (selectedMaterials.floors || (selectedMaterials.floorsVariants && selectedMaterials.floorsVariants.length)) {
            const title = 'Полы';
            const fv = selectedMaterials.floorsVariants && selectedMaterials.floorsVariants.length
                ? selectedMaterials.floorsVariants
                : (selectedMaterials.floors ? [selectedMaterials.floors] : []);
            const detailParts = [];
            fv.forEach(function (x) {
                if (x.name || x.area) {
                    const href = getMaterialLink('floors', x.type);
                    const label = formatMaterialAreaKvmLabel(x.name, x.area);
                    detailParts.push(buildMaterialDetailLinkHtml(href, label));
                }
            });
            if (fv.some(function (x) { return isCeramicOrPorcelainTileType(x.type); })) {
                detailParts.push(buildTileGroutDetailLinkHtml());
            }
            (selectedMaterials.additionalFloors || []).forEach(m => {
                if (m.type === 'skirting' && (m.name || m.area)) {
                    const skHref = getMaterialLink('skirting', m.skirtingVariant === 'tile' ? 'tile' : 'plastic');
                    const label = (m.name || 'Плинтус') + (m.area ? ' — ' + m.area : '');
                    detailParts.push(buildMaterialDetailLinkHtml(skHref, label));
                }
            });
            const details = detailParts.length ? detailParts.join('<br>') : '';
            const card = `<div class="material-category-title">${title}</div>${details ? `<div class="material-category-details">${details}</div>` : ''}`;
            html += `<div class="material-category-card">${card}</div>`;
        }
        
        if (selectedMaterials.ceilings && selectedMaterials.ceilings.length > 0) {
            const title = 'Потолки';
            const detailParts = selectedMaterials.ceilings.map(function (c) {
                const href = getMaterialLink('ceilings', c.type);
                const label = formatMaterialAreaKvmLabel(c.name, c.area);
                return buildMaterialDetailLinkHtml(href, label);
            }).filter(Boolean);
            const details = detailParts.length ? detailParts.join('<br>') : '';
            const card = `<div class="material-category-title">${title}</div>${details ? `<div class="material-category-details">${details}</div>` : ''}`;
            html += `<div class="material-category-card">${card}</div>`;
        }
        
        if (selectedMaterials.wallTile || (selectedMaterials.wallTileVariants && selectedMaterials.wallTileVariants.length)) {
            const title = 'Санузел стены';
            const wtv = selectedMaterials.wallTileVariants && selectedMaterials.wallTileVariants.length
                ? selectedMaterials.wallTileVariants
                : (selectedMaterials.wallTile ? [selectedMaterials.wallTile] : []);
            const detailParts = [];
            wtv.forEach(function (x) {
                if (x.name || x.area) {
                    const href = getMaterialLink('wallTile', x.type);
                    const label = formatMaterialAreaKvmLabel(x.name, x.area);
                    detailParts.push(buildMaterialDetailLinkHtml(href, label));
                }
            });
            if (wtv.some(function (x) { return isCeramicOrPorcelainTileType(x.type); })) {
                detailParts.push(buildTileGroutDetailLinkHtml());
            }
            const details = detailParts.length ? detailParts.join('<br>') : '';
            const card = `<div class="material-category-title">${title}</div>${details ? `<div class="material-category-details">${details}</div>` : ''}`;
            html += `<div class="material-category-card">${card}</div>`;
        }
        
        if (selectedMaterials.bathroomFloors || (selectedMaterials.bathroomFloorsVariants && selectedMaterials.bathroomFloorsVariants.length)) {
            const title = 'Санузел пол';
            const bfv = selectedMaterials.bathroomFloorsVariants && selectedMaterials.bathroomFloorsVariants.length
                ? selectedMaterials.bathroomFloorsVariants
                : (selectedMaterials.bathroomFloors ? [selectedMaterials.bathroomFloors] : []);
            const detailParts = [];
            bfv.forEach(function (x) {
                if (x.name || x.area) {
                    const href = getMaterialLink('bathroomFloor', x.type);
                    const label = formatMaterialAreaKvmLabel(x.name, x.area);
                    detailParts.push(buildMaterialDetailLinkHtml(href, label));
                }
            });
            if (bfv.some(function (x) { return isCeramicOrPorcelainTileType(x.type); })) {
                detailParts.push(buildTileGroutDetailLinkHtml());
            }
            const details = detailParts.length ? detailParts.join('<br>') : '';
            const card = `<div class="material-category-title">${title}</div>${details ? `<div class="material-category-details">${details}</div>` : ''}`;
            html += `<div class="material-category-card">${card}</div>`;
        }
        
        if (selectedMaterials.electrical && selectedMaterials.electrical.length > 0) {
            const visibleElectrical = selectedMaterials.electrical.filter(function (s) {
                return s && !ELECTRICAL_LABOR_TYPES_IN_MATERIALS_LIST.has(s.type);
            });
            if (visibleElectrical.length > 0) {
                const linksParts = visibleElectrical.map(function (s) {
                    const href = getMaterialLink('electrical', s.type);
                    const q = (s.quantity && parseInt(s.quantity, 10)) ? ' (' + s.quantity + ')' : '';
                    return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer" class="material-detail-link">${s.name}${q}</a>` : `<span>${s.name}${q}</span>`;
                });
                const card = `<div class="material-category-title">Электромонтаж</div><div class="material-category-details">${linksParts.join('<br>')}</div>`;
                html += `<div class="material-category-card">${card}</div>`;
            }
        }
        
        if (selectedMaterials.stage4GeneralFix) {
            const card = '<div class="material-category-title">Общий фикс этап 4</div><div class="material-category-details">Расходники и фитинги РТП (этап 4 корзины)</div>';
            html += `<div class="material-category-card">${card}</div>`;
        }

        if (selectedMaterials.plumbing && selectedMaterials.plumbing.length > 0) {
            const linksParts = selectedMaterials.plumbing.map(s => {
                const href = getMaterialLink('plumbing', s.type);
                const q = (s.quantity && parseInt(s.quantity, 10)) ? ' (' + s.quantity + ')' : '';
                return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer" class="material-detail-link">${s.name}${q}</a>` : `<span>${s.name}${q}</span>`;
            });
            const card = `<div class="material-category-title">Сантехмонтаж</div><div class="material-category-details">${linksParts.join('<br>')}</div>`;
            html += `<div class="material-category-card">${card}</div>`;
        }
        
        if (selectedMaterials.lighting && selectedMaterials.lighting.length > 0) {
            const linksParts = selectedMaterials.lighting.map(s => {
                const href = getMaterialLink('lighting', s.type);
                const q = (s.quantity && parseInt(s.quantity, 10)) ? ' (' + s.quantity + ')' : '';
                return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer" class="material-detail-link">${s.name}${q}</a>` : `<span>${s.name}${q}</span>`;
            });
            const card = `<div class="material-category-title">Освещение</div><div class="material-category-details">${linksParts.join('<br>')}</div>`;
            html += `<div class="material-category-card">${card}</div>`;
        }

        /* Окна и двери — только работы в смете; в корзину материалов и в этот список не входят. */

        html += '</div>';
        return html;
    }

function parseMaterialsLinksFromHtml(html) {
    const sections = [];
    if (!html || html.indexOf('material-category-card') < 0) return sections;
    if (typeof DOMParser === 'undefined') return sections;
    const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    const root = doc.body.firstElementChild;
    if (!root) return sections;
    root.querySelectorAll('.material-category-card').forEach(function (card) {
        const titleEl = card.querySelector('.material-category-title');
        const titleText = titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '';
        const items = [];
        const details = card.querySelector('.material-category-details');
        if (details) {
            details.querySelectorAll('a.material-detail-link').forEach(function (a) {
                const label = a.textContent.replace(/\s+/g, ' ').trim();
                const href = a.getAttribute('href') || '';
                if (label) items.push({ label: label, href: href });
            });
            details.querySelectorAll(':scope > span').forEach(function (sp) {
                const label = sp.textContent.replace(/\s+/g, ' ').trim();
                if (label) items.push({ label: label, href: '' });
            });
            if (!items.length) {
                const plain = details.textContent.replace(/\s+/g, ' ').trim();
                if (plain) items.push({ label: plain, href: '' });
            }
        }
        if (titleText || items.length) sections.push({ title: titleText, items: items });
    });
    return sections;
}

function exportMaterialsLinksToExcel(address) {
    const sections = parseMaterialsLinksFromHtml(buildMaterialsListHtml());
    if (!sections.length || !sections.some(function (s) { return s.items && s.items.length; })) {
        return false;
    }
    const rawAddr = address != null ? String(address).trim() : '';
    const docTitle = rawAddr ? ('Материалы и услуги — ' + rawAddr) : 'Материалы и услуги';
    const downloadFilename = excelExportFilenameStem('materialy', rawAddr);
    let htmlContent = `
            <!DOCTYPE html>
            <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
            <head>
                <meta charset="UTF-8">
                <style>
                    table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: top; }
                    th { background-color: #4472C4; color: white; font-weight: bold; }
                    .category { background-color: #D9E2F3 !important; font-weight: bold; color: #2F5597; }
                    a { color: #0563C1; text-decoration: underline; word-break: break-all; }
                </style>
            </head>
            <body>
                <h2 style="text-align: center; color: #2F5597;">${escapeHtmlText(docTitle)}</h2>
                <table>
                    <thead>
                        <tr>
                            <th style="width: 18%;">Раздел</th>
                            <th style="width: 32%;">Позиция</th>
                            <th style="width: 50%;">Ссылка</th>
                        </tr>
                    </thead>
                    <tbody>
        `;
    sections.forEach(function (sec) {
        htmlContent += `<tr class="category"><td colspan="3">${escapeHtmlText(sec.title || '')}</td></tr>`;
        (sec.items || []).forEach(function (item) {
            const linkCell = item.href
                ? `<a href="${escapeHtmlText(item.href)}">${escapeHtmlText(item.href)}</a>`
                : '';
            htmlContent += '<tr>';
            htmlContent += '<td></td>';
            htmlContent += '<td>' + escapeHtmlText(item.label) + '</td>';
            htmlContent += '<td>' + linkCell + '</td>';
            htmlContent += '</tr>';
        });
    });
    htmlContent += `
                    </tbody>
                </table>
            </body>
            </html>
        `;
    downloadExcelHtmlFile(htmlContent, downloadFilename);
    return true;
}

        function applyCheckedSubtopics(keys, electricalPcs, demolitionSqm, lastCalculations, partitionSqm, perSubtopicSqm, lightingPcs, bathFloorPcs, plumbingPcs, perSubtopicThickness, skirtingOpts, windowsDoorsPcs) {
            if (!Array.isArray(keys)) keys = [];
            
            /* Ни один чекбокс не отмечен — ничего не конфигурируем для сметы (пустой выбор). */
            if (keys.length === 0) {
                clearSpravSelectedMaterials();
                return;
            }
            const set = new Set(keys.filter(Boolean));
            const lc = lastCalculations;
            const wallSq = lc ? lc.totalWallArea : 0;
            const lamSq = lc && lc.materials ? lc.materials.laminate : 0;
            const floorTileSq = lc && lc.materials ? lc.materials.floorTile : 0;
            const wallTileSq = lc && lc.materials ? lc.materials.wallTile : 0;
            const ceilSq = lc ? lc.totalCeilingArea : 0;
            const wallStr = wallSq + ' м²';
            const lamStr = lamSq + ' м²';
            const ftStr = floorTileSq + ' м²';
            const wtStr = wallTileSq + ' м²';
            const ceilStr = ceilSq + ' м²';

            const perSub = (perSubtopicSqm && typeof perSubtopicSqm === 'object' && !Array.isArray(perSubtopicSqm)) ? perSubtopicSqm : null;
            const perThick = (perSubtopicThickness && typeof perSubtopicThickness === 'object' && !Array.isArray(perSubtopicThickness)) ? perSubtopicThickness : null;
            function qSqmSub(subId, baseNum) {
                if (perSub && perSub[subId] != null && perSub[subId] !== '') {
                    const n = parseFloat(String(perSub[subId]).replace(',', '.'));
                    if (!isNaN(n) && n > 0) return n;
                }
                return baseNum;
            }
            function qThickSub(subId) {
                if (!perThick || perThick[subId] == null || perThick[subId] === '') return null;
                const n = parseFloat(String(perThick[subId]).replace(',', '.'));
                if (!isNaN(n) && n > 0) return n;
                return null;
            }
            function withLayerThickness(obj, subId) {
                const t = qThickSub(subId);
                if (t != null) obj.thicknessMm = t;
                return obj;
            }
            function strSqm(n) {
                return n + ' м²';
            }

            clearSpravSelectedMaterials();

            const demSq = (demolitionSqm && typeof demolitionSqm === 'object') ? demolitionSqm : {};
            function qDemoWallSqm() {
                const v = demSq.wallSqm;
                if (v === '' || v == null || v === undefined) return 1;
                const n = parseFloat(String(v).replace(',', '.'));
                if (isNaN(n) || n <= 0) return 1;
                return n;
            }
            function qDemoFloorSqm() {
                const v = demSq.floorSqm;
                if (v === '' || v == null || v === undefined) return 1;
                const n = parseFloat(String(v).replace(',', '.'));
                if (isNaN(n) || n <= 0) return 1;
                return n;
            }
            selectedMaterials.demolition = [];
            if (set.has('demo-wall')) {
                selectedMaterials.demolition.push({
                    type: 'demoWall',
                    name: 'Демонтаж перегородки / стены',
                    quantity: qSqmSub('demo-wall', qDemoWallSqm()),
                    unit: 'м²'
                });
            }
            if (set.has('demo-floor')) {
                selectedMaterials.demolition.push({
                    type: 'demoFloor',
                    name: 'Демонтаж пола',
                    quantity: qSqmSub('demo-floor', qDemoFloorSqm()),
                    unit: 'м²'
                });
            }
            if (set.has('demo-linoleum')) {
                selectedMaterials.demolition.push({
                    type: 'demoLinoleum',
                    name: 'Демонтаж линолеума',
                    quantity: qSqmSub('demo-linoleum', lamSq > 0 ? lamSq : qDemoFloorSqm()),
                    unit: 'м²'
                });
            }
            if (set.has('demo-wallpaper')) {
                selectedMaterials.demolition.push({
                    type: 'demoWallpaper',
                    name: 'Демонтаж обоев',
                    quantity: qSqmSub('demo-wallpaper', qDemoWallSqm()),
                    unit: 'м²'
                });
            }
            if (set.has('demo-paint')) {
                selectedMaterials.demolition.push({
                    type: 'demoPaint',
                    name: 'Демонтаж краски',
                    quantity: qSqmSub('demo-paint', qDemoWallSqm()),
                    unit: 'м²'
                });
            }

            selectedMaterials.partitions = [];
            const bfPcs = (bathFloorPcs && typeof bathFloorPcs === 'object') ? bathFloorPcs : {};
            const partKeys = ['part-pgb', 'part-foam', 'part-brick', 'part-gypsum', 'part-gypsum-box'];
            let anyPart = false;
            for (let pi = 0; pi < partKeys.length; pi++) {
                if (set.has(partKeys[pi])) { anyPart = true; break; }
            }
            function qPartSqm(subtopicId) {
                const def = 10;
                if (partitionSqm != null && typeof partitionSqm === 'object' && !Array.isArray(partitionSqm)) {
                    const v = partitionSqm[subtopicId];
                    if (v !== undefined && v !== null && v !== '') {
                        const pn = parseFloat(String(v).replace(',', '.'));
                        if (!isNaN(pn) && pn > 0) return pn;
                    }
                    return def;
                }
                if (partitionSqm != null && partitionSqm !== '' && typeof partitionSqm !== 'object') {
                    const pn = parseFloat(String(partitionSqm).replace(',', '.'));
                    if (!isNaN(pn) && pn > 0) return pn;
                }
                return def;
            }
            if (anyPart) {
                if (set.has('part-pgb')) {
                    selectedMaterials.partitions.push({ type: 'pgb', name: 'Устройство перегородки из пазогребных плит (ПГП)', quantity: qPartSqm('part-pgb'), unit: 'м²' });
                }
                if (set.has('part-foam')) {
                    selectedMaterials.partitions.push({ type: 'foam', name: 'Устройство перегородки из пеноблоков', quantity: qPartSqm('part-foam'), unit: 'м²' });
                }
                if (set.has('part-brick')) {
                    selectedMaterials.partitions.push({ type: 'brick', name: 'Устройство перегородки из кирпича', quantity: qPartSqm('part-brick'), unit: 'м²' });
                }
                if (set.has('part-gypsum')) {
                    selectedMaterials.partitions.push({ type: 'gypsumFrame', name: 'Устройство перегородки из гипсокартона на каркасе', quantity: qPartSqm('part-gypsum'), unit: 'м²' });
                }
                if (set.has('part-gypsum-box')) {
                    let nPartBox = 1;
                    const rawPart = bfPcs.partGypsumBoxPcs != null ? parseInt(bfPcs.partGypsumBoxPcs, 10) : NaN;
                    if (!isNaN(rawPart) && rawPart > 0) nPartBox = rawPart;
                    selectedMaterials.partitions.push({ type: 'gypsumBox', name: 'Устройство гипсокартонного короба', quantity: nPartBox, unit: 'шт.' });
                }
            }

            const wallFinishOrder = ['walls-tile-porcelain', 'walls-tile-ceramic', 'walls-panels', 'walls-gypsum', 'walls-decorative', 'walls-paint', 'walls-wallpaper'];
            const wallTypeMap = {
                'walls-wallpaper': { type: 'wallpaper', name: 'Обои' },
                'walls-paint': { type: 'paint', name: 'Покраска' },
                'walls-decorative': { type: 'decorative', name: 'Декоративная штукатурка' },
                'walls-panels': { type: 'panels', name: 'Панели' },
                'walls-gypsum': { type: 'gypsumFrame', name: 'Стены из гипсокартона' },
                'walls-tile-ceramic': { type: 'tile', name: 'Керамическая плитка' },
                'walls-tile-porcelain': { type: 'porcelain', name: 'Керамогранит' }
            };
            selectedMaterials.wallsVariants = [];
            for (let wi = 0; wi < wallFinishOrder.length; wi++) {
                const wKey = wallFinishOrder[wi];
                if (set.has(wKey) && wallTypeMap[wKey]) {
                    const w = wallTypeMap[wKey];
                    selectedMaterials.wallsVariants.push({
                        type: w.type,
                        name: w.name,
                        area: strSqm(qSqmSub(wKey, wallSq))
                    });
                }
            }
            if (selectedMaterials.wallsVariants.length > 0) {
                selectedMaterials.walls = selectedMaterials.wallsVariants[0];
            } else {
                selectedMaterials.walls = null;
            }
            if (set.has('walls-plaster')) {
                selectedMaterials.additionalWalls.push(withLayerThickness({ type: 'plaster', name: 'Штукатурка стен', area: strSqm(qSqmSub('walls-plaster', wallSq)) }, 'walls-plaster'));
            }
            let wallPuttySqmAcc = 0;
            if (set.has('walls-putty-wallpaper')) {
                const sqWp = qSqmSub('walls-putty-wallpaper', wallSq);
                wallPuttySqmAcc += sqWp;
                selectedMaterials.additionalWalls.push({ type: 'puttyWallpaper', name: 'Шпаклёвка стен под обои', area: strSqm(sqWp) });
            }
            if (set.has('walls-putty-paint')) {
                const sqPp = qSqmSub('walls-putty-paint', wallSq);
                wallPuttySqmAcc += sqPp;
                selectedMaterials.additionalWalls.push({ type: 'puttyPaint', name: 'Шпаклёвка стен под окраску', area: strSqm(sqPp) });
            }
            if (wallPuttySqmAcc > 0) {
                selectedMaterials.wallPuttyAreaM2 = wallPuttySqmAcc;
            }
            if (set.has('walls-apron')) {
                const apronLengthM = qSqmSub('walls-apron', 5);
                const apronAreaSqm = apronLengthM * 0.6; // фиксированная высота фартука 0.60 м
                selectedMaterials.additionalWalls.push({ type: 'ceramicGraniteApron', name: 'Фартук из керамогранита', area: strSqm(apronAreaSqm) });
            }

            const floorOrder = ['floor-tile', 'floor-porcelain', 'floor-mosaic', 'floor-pvc', 'floor-laminate', 'floor-parquet', 'floor-carpet', 'floor-linoleum'];
            const floorTypeMap = {
                'floor-laminate': { type: 'laminate', name: 'Ламинат' },
                'floor-parquet': { type: 'parquet', name: 'Паркет' },
                'floor-carpet': { type: 'carpet', name: 'Ковролин' },
                'floor-linoleum': { type: 'linoleum', name: 'Линолеум' },
                'floor-pvc': { type: 'pvc', name: 'ПВХ плитка' },
                'floor-tile': { type: 'porcelain', name: 'Керамогранит' },
                'floor-porcelain': { type: 'porcelain', name: 'Керамогранит' },
                'floor-mosaic': { type: 'mosaic', name: 'Мозаика' }
            };
            selectedMaterials.floorsVariants = [];
            for (let fi = 0; fi < floorOrder.length; fi++) {
                const fKey = floorOrder[fi];
                if (set.has(fKey) && floorTypeMap[fKey]) {
                    const f = floorTypeMap[fKey];
                    selectedMaterials.floorsVariants.push({
                        type: f.type,
                        name: f.name,
                        area: strSqm(qSqmSub(fKey, lamSq))
                    });
                }
            }
            if (selectedMaterials.floorsVariants.length > 0) {
                selectedMaterials.floors = selectedMaterials.floorsVariants[0];
            } else {
                selectedMaterials.floors = null;
            }
            if (set.has('floor-skirting')) {
                const skOpt = (skirtingOpts && typeof skirtingOpts === 'object') ? skirtingOpts : null;
                const skVariant = (skOpt && skOpt.variant === 'tile') ? 'tile' : 'plastic';
                const skName = skVariant === 'tile' ? 'Плинтус из плитки' : 'Плинтус (пластиковый)';
                let skPerim = qSqmSub('floor-skirting', 0);
                if (!(skPerim > 0) && lastCalculations) {
                    skPerim = skirtingPerimeterMFromCalcObj(lastCalculations);
                }
                if (!(skPerim > 0) && lamSq > 0) {
                    skPerim = floorPerimeterMFromAreaSqm(lamSq);
                }
                skPerim = Math.round(skPerim * 10) / 10;
                selectedMaterials.additionalFloors.push({
                    type: 'skirting',
                    name: skName,
                    perimeterM: skPerim,
                    area: skPerim + ' п.м.',
                    skirtingVariant: skVariant
                });
            }
            if (set.has('floor-extra-screed')) {
                selectedMaterials.additionalFloors.push(withLayerThickness({ type: 'screed', name: 'Стяжка пола', area: strSqm(qSqmSub('floor-extra-screed', lamSq)) }, 'floor-extra-screed'));
            }
            if (set.has('floor-extra-self')) {
                selectedMaterials.additionalFloors.push(withLayerThickness({ type: 'selfLeveling', name: 'Наливной пол', area: strSqm(qSqmSub('floor-extra-self', lamSq)) }, 'floor-extra-self'));
            }

            const bathFloorOrder = ['bf-tile-porcelain'];
            const bathFloorTypeMap = {
                'bf-tile-porcelain': { type: 'porcelain', name: 'Керамогранит' }
            };
            selectedMaterials.bathroomFloorsVariants = [];
            for (let bfi = 0; bfi < bathFloorOrder.length; bfi++) {
                const bfKey = bathFloorOrder[bfi];
                if (set.has(bfKey) && bathFloorTypeMap[bfKey]) {
                    const bf = bathFloorTypeMap[bfKey];
                    selectedMaterials.bathroomFloorsVariants.push({
                        type: bf.type,
                        name: bf.name,
                        area: strSqm(qSqmSub(bfKey, floorTileSq))
                    });
                }
            }
            if (selectedMaterials.bathroomFloorsVariants.length > 0) {
                selectedMaterials.bathroomFloors = selectedMaterials.bathroomFloorsVariants[0];
            } else {
                selectedMaterials.bathroomFloors = null;
            }
            if (set.has('bf-extra-screed')) {
                selectedMaterials.additionalBathroomFloors.push(withLayerThickness({ type: 'screed', name: 'Стяжка пола (санузел)', area: strSqm(qSqmSub('bf-extra-screed', floorTileSq)) }, 'bf-extra-screed'));
            }
            if (set.has('bf-extra-self')) {
                selectedMaterials.additionalBathroomFloors.push(withLayerThickness({ type: 'selfLeveling', name: 'Наливной пол (санузел)', area: strSqm(qSqmSub('bf-extra-self', floorTileSq)) }, 'bf-extra-self'));
            }

            if (set.has('bf-tray-porcelain')) {
                selectedMaterials.bathroomPorcelainTrayEnabled = true;
                const rawTraySqm = bfPcs.bfTrayPorcelainSqm;
                if (rawTraySqm !== '' && rawTraySqm != null && rawTraySqm !== undefined) {
                    const traySqm = parseFloat(String(rawTraySqm).replace(',', '.'));
                    if (!isNaN(traySqm) && traySqm > 0) selectedMaterials.bathroomPorcelainTraySqm = traySqm;
                }
                if (!(selectedMaterials.bathroomPorcelainTraySqm > 0)) selectedMaterials.bathroomPorcelainTraySqm = 1;
            } else if (set.has('plumb-tray')) {
                const rawTraySqm = bfPcs.bfTrayPorcelainSqm;
                if (rawTraySqm !== '' && rawTraySqm != null && rawTraySqm !== undefined) {
                    const traySqm = parseFloat(String(rawTraySqm).replace(',', '.'));
                    if (!isNaN(traySqm) && traySqm > 0) selectedMaterials.bathroomPorcelainTraySqm = traySqm;
                }
                if (!(selectedMaterials.bathroomPorcelainTraySqm > 0)) selectedMaterials.bathroomPorcelainTraySqm = 1;
            }

            const bwFinishOrder = ['bw-tile-porcelain', 'bw-tile-ceramic', 'bw-mosaic'];
            const bwTypeMap = {
                'bw-tile-porcelain': { type: 'porcelain', name: 'Керамогранит' },
                'bw-tile-ceramic': { type: 'ceramic', name: 'Керамическая плитка' },
                'bw-mosaic': { type: 'mosaic', name: 'Мозаика' }
            };
            selectedMaterials.wallTileVariants = [];
            for (let bwi = 0; bwi < bwFinishOrder.length; bwi++) {
                const bwKey = bwFinishOrder[bwi];
                if (set.has(bwKey) && bwTypeMap[bwKey]) {
                    const bw = bwTypeMap[bwKey];
                    selectedMaterials.wallTileVariants.push({
                        type: bw.type,
                        name: bw.name,
                        area: strSqm(qSqmSub(bwKey, wallTileSq)),
                        quantity: 1
                    });
                }
            }
            if (selectedMaterials.wallTileVariants.length > 0) {
                selectedMaterials.wallTile = selectedMaterials.wallTileVariants[0];
            } else {
                selectedMaterials.wallTile = null;
            }
            /* Штукатурка под плитку — отдельно от типа плитки стен (как короб / запил 45°): иначе при одном только bw-plaster не формировались смета и корзина. */
            if (set.has('bw-plaster')) {
                selectedMaterials.additionalWallTile.push(withLayerThickness({ type: 'plaster', name: 'Штукатурка стен под плитку', area: strSqm(qSqmSub('bw-plaster', wallTileSq)), quantity: 1 }, 'bw-plaster'));
            }
            /* Короб в санузле — отдельная позиция: не привязывать к выбору типа плитки (иначе при одном только «Гипсокартонный короб» строка не попадала в смету и материалы). */
            if (set.has('bw-box')) {
                let qBwBox = 1;
                const qRaw = bfPcs.bwWallBox != null ? parseInt(bfPcs.bwWallBox, 10) : NaN;
                if (!isNaN(qRaw) && qRaw > 0) qBwBox = qRaw;
                selectedMaterials.additionalWallTile.push({ type: 'box', name: 'Короб', area: '0', quantity: qBwBox });
            }

            /* Запил под 45° — не привязан к выбору типа плитки стен; п.м. из поля refSqm_bw_tile45 или 12 по умолчанию */
            if (set.has('bw-tile45')) {
                let q45 = 12;
                if (perSub && perSub['bw-tile45'] != null && perSub['bw-tile45'] !== '') {
                    const n45 = parseFloat(String(perSub['bw-tile45']).replace(',', '.'));
                    if (!isNaN(n45) && n45 > 0) q45 = n45;
                }
                const q45Qty = Math.max(0.1, q45);
                selectedMaterials.additionalWallTile.push({ type: 'tile45Cut', name: 'Запил плитки под 45°', area: '0', quantity: q45Qty });
            }

            if (set.has('ceil-stretch')) {
                selectedMaterials.ceilings.push({ type: 'stretch', name: 'Натяжные потолки', area: strSqm(qSqmSub('ceil-stretch', ceilSq)), quantity: 1 });
            }
            if (set.has('ceil-fabric')) {
                selectedMaterials.ceilings.push({ type: 'fabric', name: 'Тканевые потолки', area: strSqm(qSqmSub('ceil-fabric', ceilSq)), quantity: 1 });
            }
            if (set.has('ceil-plaster')) {
                selectedMaterials.ceilings.push({ type: 'plasterCeiling', name: 'Штукатурка потолков', area: strSqm(qSqmSub('ceil-plaster', ceilSq)), quantity: 1 });
            }
            if (set.has('ceil-putty')) {
                selectedMaterials.ceilings.push({ type: 'puttyCeiling', name: 'Шпаклёвка потолков', area: strSqm(qSqmSub('ceil-putty', ceilSq)), quantity: 1 });
            }
            if (set.has('ceil-paint')) {
                selectedMaterials.ceilings.push({ type: 'paintCeiling', name: 'Покраска потолков', area: strSqm(qSqmSub('ceil-paint', ceilSq)), quantity: 1 });
            }
            if (set.has('ceil-armstrong')) {
                selectedMaterials.ceilings.push({ type: 'armstrong', name: 'Потолок Армстронг', area: strSqm(qSqmSub('ceil-armstrong', ceilSq)), quantity: 1 });
            }

            const elPcs = (electricalPcs && typeof electricalPcs === 'object') ? electricalPcs : {};
            function qElec(key, def) {
                const v = elPcs[key];
                if (v === '' || v == null || v === undefined) return def;
                const n = parseInt(v, 10);
                if (isNaN(n) || n <= 0) return def;
                return n;
            }
            function qElecFloat(key, def) {
                const v = elPcs[key];
                if (v === '' || v == null || v === undefined) return def;
                const n = parseFloat(String(v).replace(',', '.'));
                if (isNaN(n) || n < 0) return def;
                return n;
            }
            const elRows = [
                ['el-outlets', 'outlets', 'Розетки', 'outlets', 6],
                ['el-switches', 'switches', 'Выключатели', 'switches', 4],
                ['el-junction', 'junctionBoxes', 'Монтаж распределительных коробок', 'junctionBoxes', 4]
            ];
            elRows.forEach(function (row) {
                if (set.has(row[0])) {
                    const qty = row[3] != null ? qElec(row[3], row[4]) : row[4];
                    selectedMaterials.electrical.push({ type: row[1], name: row[2], quantity: qty });
                }
            });
            let totalOutletsSprav = 0;
            let totalSwitchesSprav = 0;
            let totalThermSprav = 0;
            if (set.has('el-outlets')) totalOutletsSprav = qElec('outlets', 6);
            if (set.has('el-switches')) totalSwitchesSprav = qElec('switches', 4);
            if (set.has('el-extra-thermostat')) totalThermSprav = qElec('elExtraThermostat', 1);
            /* Терморегулятор: как розетка — штробление, подрозетники, кабель 3×2,5 в штробе. Эл.полотенцесушитель — в смете только строка «Установка...», без штробления/подрозетников/каналов. */
            const totalOutletsAndSwitchesSprav = totalOutletsSprav + totalSwitchesSprav + totalThermSprav;
            const baseChasingWireLenSprav = (totalOutletsSprav * 2.5) + (totalSwitchesSprav * 2) + (totalThermSprav * 2.5);
            if (totalOutletsAndSwitchesSprav > 0) {
                selectedMaterials.electrical.push({ type: 'outletChasing', name: 'Штробление отверстий для подрозетников', quantity: totalOutletsAndSwitchesSprav });
                selectedMaterials.electrical.push({ type: 'outletBoxes', name: 'Установка подрозетников', quantity: totalOutletsAndSwitchesSprav });
            }
            if (baseChasingWireLenSprav > 0) {
                selectedMaterials.electrical.push({ type: 'electricalChasing', name: 'Штробление каналов под электропроводку', quantity: baseChasingWireLenSprav });
                selectedMaterials.electrical.push({ type: 'wireLaying', name: 'Укладка проводов в штробе с заделкой штробы', quantity: baseChasingWireLenSprav });
            }
            function electricalHasType(tp) {
                return selectedMaterials.electrical.some(function (s) { return s.type === tp; });
            }
            var EL_EXTRA_BREAKER_SKU_IDS = [18072264, 18072272, 18072299, 18072301, 18072328, 18072408];
            var EL_EXTRA_RCBO_SKU_IDS = [18072504, 18072512];
            function elExtraAllBreakerSkuIds() {
                return EL_EXTRA_BREAKER_SKU_IDS.concat(EL_EXTRA_RCBO_SKU_IDS);
            }
            function sumElExtraBreakerSkus(pcs) {
                var sum = 0;
                elExtraAllBreakerSkuIds().forEach(function (id) {
                    var k = 'elExtraBreaker_' + id;
                    var v = pcs[k];
                    if (v === '' || v == null || v === undefined) return;
                    var n = parseInt(v, 10);
                    if (!isNaN(n) && n >= 0) sum += n;
                });
                return sum;
            }
            if (set.has('el-extra-panel') && !electricalHasType('panel')) {
                selectedMaterials.electrical.push({ type: 'panel', name: 'Установка электрощитка', quantity: qElec('elExtraPanel', 1) });
            }
            if (set.has('el-extra-breakers') && !electricalHasType('breakers')) {
                var sumBrSku = sumElExtraBreakerSkus(elPcs);
                var qtyBreakersInstall = sumBrSku > 0 ? sumBrSku : qElec('elExtraBreakers', 8);
                selectedMaterials.electrical.push({ type: 'breakers', name: 'Установка автоматов', quantity: qtyBreakersInstall });
                if (sumBrSku > 0) {
                    var bx = {};
                    elExtraAllBreakerSkuIds().forEach(function (id) {
                        var k = 'elExtraBreaker_' + id;
                        var v = elPcs[k];
                        if (v === '' || v == null || v === undefined) return;
                        var n = parseInt(v, 10);
                        if (!isNaN(n) && n > 0) bx[id] = n;
                    });
                    if (Object.keys(bx).length) selectedMaterials.breakerExtraBySku = bx;
                }
            }
            if (set.has('el-extra-fan')) {
                selectedMaterials.electrical.push({ type: 'exhaustfan', name: 'Установка вытяжного вентилятора', quantity: qElec('elExtraFan', 1) });
            }
            if (set.has('el-extra-ceiling')) {
                const cableM = {};
                let sumCableM = 0;
                CEILING_WIRING_CABLE_SKUS.forEach(function (sku) {
                    const m = qElecFloat('elExtraCeilingCable_' + sku, 0);
                    if (m > 0) {
                        cableM[sku] = m;
                        sumCableM += m;
                    }
                });
                let pmCeil = sumCableM > 0 ? sumCableM : qElecFloat('elExtraCeilingPm', 0);
                if ((!pmCeil || pmCeil <= 0) && lc && typeof lc.totalCeilingArea === 'number' && lc.totalCeilingArea > 0) {
                    pmCeil = lc.totalCeilingArea;
                }
                if (pmCeil > 0) {
                    selectedMaterials.electrical.push({ type: 'ceilingWiring', name: 'Укладка проводов по потолку', quantity: pmCeil });
                }
                if (Object.keys(cableM).length > 0) selectedMaterials.ceilingCableM = cableM;
            }
            if (set.has('el-extra-warmfloor')) {
                const sqWf = qElecFloat('elExtraWarmFloorSqm', 0);
                if (sqWf > 0) {
                    selectedMaterials.electrical.push({ type: 'warmFloor', name: 'Монтаж тёплого пола (электрического)', quantity: sqWf });
                }
            }
            if (set.has('el-extra-thermostat')) {
                selectedMaterials.electrical.push({ type: 'thermostat', name: 'Установка терморегулятора', quantity: qElec('elExtraThermostat', 1) });
            }
            if (set.has('el-extra-towelwarmer')) {
                selectedMaterials.electrical.push({ type: 'electricTowelWarmer', name: 'Установка электрического полотенцесушителя', quantity: qElec('elExtraTowelWarmer', 1) });
            }

            const plPcs = (plumbingPcs && typeof plumbingPcs === 'object' && !Array.isArray(plumbingPcs)) ? plumbingPcs : {};
            function qPlumb(svcType) {
                const v = plPcs[svcType];
                const n = parseInt(v, 10);
                if (!isNaN(n) && n > 0) return n;
                return 1;
            }
            const plRows = [
                ['plumb-installation', 'installation', 'Инсталляция'],
                ['plumb-toilet', 'toilet', 'Унитаз (напольный)'],
                ['plumb-bathtub', 'bathtub', 'Ванна'],
                ['plumb-shower', 'shower', 'Душевая кабина'],
                ['plumb-tray', 'tray', 'Поддон из керамогранита'],
                ['plumb-sink', 'sink', 'Установка раковины'],
                ['plumb-sinkcabinet', 'sinkcabinet', 'Установка раковины с тумбой'],
                ['plumb-heating', 'heating', 'Радиатор отопления'],
                ['plumb-waterheater', 'waterheater', 'Водонагреватель'],
                ['plumb-towelwarmer', 'towelwarmer', 'Полотенцесушитель (водяной)'],
                ['plumb-glassdoors', 'glassdoors', 'Установка стеклянных дверок'],
                ['plumb-showersystem', 'showersystem', 'Установка душевой системы'],
                ['plumb-mirrors', 'mirrors', 'Навес зеркал, полок'],
                ['plumb-wm', 'washingmachine', 'Подключение стиральной машины'],
                ['plumb-dw', 'dishwasher', 'Посудомойка (кухня)'],
                ['plumb-kitchensink', 'kitchensink', 'Мойка (кухня)'],
                ['plumb-sololift', 'sololift', 'Сололифт']
            ];
            plRows.forEach(function (row) {
                if (set.has(row[0])) {
                    selectedMaterials.plumbing.push({ type: row[1], name: row[2], quantity: qPlumb(row[1]) });
                }
            });
            if (set.has('plumb-installation')) {
                const instQtyWall = qPlumb('installation');
                selectedMaterials.plumbing.push({ type: 'walltoilet', name: 'Установка подвесного унитаза', quantity: instQtyWall });
            }
            selectedMaterials.stage4GeneralFix = set.has('plumb-fix4');

            const liP = (lightingPcs && typeof lightingPcs === 'object') ? lightingPcs : {};
            function qLight(key, def) {
                const v = liP[key];
                if (v === '' || v == null || v === undefined) return def;
                const n = parseInt(v, 10);
                if (isNaN(n) || n <= 0) return def;
                return n;
            }
            const liRows = [
                ['light-spots', 'spots', 'Точечные светильники', 'spots', 6],
                ['light-chandelier', 'chandelier', 'Люстра', 'chandelier', 1],
                ['light-led', 'led', 'LED панели', 'led', 1],
                ['light-track', 'track', 'Трековые светильники', 'track', 1],
                ['light-sconce', 'sconce', 'Бра', 'sconce', 2],
                ['light-floor', 'floor', 'Торшер', 'floor', 1]
            ];
            liRows.forEach(function (row) {
                if (set.has(row[0])) {
                    const qty = qLight(row[3], row[4]);
                    selectedMaterials.lighting.push({ type: row[1], name: row[2], quantity: qty });
                }
            });

            const wdP = (windowsDoorsPcs && typeof windowsDoorsPcs === 'object') ? windowsDoorsPcs : {};
            selectedMaterials.windowsDoors = [];
            const wdRows = [
                ['wd-windows', 'windows', 'Окна'],
                ['wd-slopes', 'slopes', 'Откосы'],
                ['wd-sills', 'sills', 'Подоконники'],
                ['wd-openings', 'openings', 'Формирование проёмов'],
                ['wd-doors', 'doors', 'Межкомнатные двери'],
                ['wd-trim', 'trim', 'Наличники'],
                ['wd-extensions', 'extensions', 'Доборы'],
                ['wd-locks', 'locks', 'Замки и фурнитура'],
                ['wd-other', 'other', 'Прочее']
            ];
            /* Только явное количество в поле баннера — чекбокс без числа не добавляет работу и не «материал». */
            wdRows.forEach(function (row) {
                if (!set.has(row[0])) return;
                const v = wdP[row[1]];
                if (v === '' || v == null || v === undefined) return;
                const n = parseInt(v, 10);
                if (isNaN(n) || n <= 0) return;
                selectedMaterials.windowsDoors.push({ type: row[1], name: row[2], quantity: n });
            });

        }
    function generateDetailedEstimateData(apartmentTypeForGarbage, meta) {
        meta = meta && typeof meta === 'object' ? meta : {};
        const rawAddr = (meta.address != null && String(meta.address).trim()) ? String(meta.address).trim() : '';
        const documentTitle = rawAddr
            ? ('Смета на ремонт — ' + rawAddr)
            : 'Смета на ремонт';

        const sections = [];
        let totalCost = 0;

        // Демонтаж — первым в смете (справочник: demo-wall, demo-floor, demo-linoleum, demo-wallpaper, demo-paint)
        if (selectedMaterials.demolition && selectedMaterials.demolition.length > 0) {
            const demolitionSection = {
                name: "ДЕМОНТАЖНЫЕ РАБОТЫ",
                subsections: [{
                    name: "",
                    items: []
                }]
            };
            selectedMaterials.demolition.forEach(function (job) {
                let workRate = 0;
                switch (job.type) {
                    case 'demoWall':
                        workRate = 950;
                        break;
                    case 'demoFloor':
                        workRate = 650;
                        break;
                    case 'demoLinoleum':
                        workRate = 150;
                        break;
                    case 'demoWallpaper':
                        workRate = 120;
                        break;
                    case 'demoPaint':
                        workRate = 200;
                        break;
                    default:
                        workRate = 0;
                }
                const qty = parseFloat(job.quantity);
                const q = (!isNaN(qty) && qty > 0) ? qty : 1;
                const unit = job.unit || 'шт.';
                if (workRate > 0) {
                    const qtyStr = unit === 'м²' ? q.toFixed(1) : String(Math.round(q));
                    demolitionSection.subsections[0].items.push({
                        name: job.name || 'Демонтаж',
                        rate: workRate,
                        quantity: qtyStr,
                        unit: unit === 'м²' ? 'кв.м.' : 'шт.',
                        total: (q * workRate).toFixed(1)
                    });
                }
            });
            if (demolitionSection.subsections[0].items.length > 0) {
                sections.push(demolitionSection);
            }
        }

        if (selectedMaterials.partitions && selectedMaterials.partitions.length > 0) {
            const PARTITION_WORK_RATES = {
                pgb: 1100,
                foam: 950,
                brick: 2200,
                gypsumFrame: 1200,
                gypsumBox: 1900
            };
            const PARTITION_GYPSUM_FRAME_INSULATION_RATE = 160;
            const partitionSection = {
                name: 'УСТРОЙСТВО ПЕРЕГОРОДОК',
                subsections: [{ name: '', items: [] }]
            };
            selectedMaterials.partitions.forEach(function (job) {
                const w = PARTITION_WORK_RATES[job.type] || 1000;
                if (job.type === 'gypsumBox' && job.unit === 'шт.') {
                    const n = parseInt(String(job.quantity), 10);
                    const nn = (!isNaN(n) && n > 0) ? n : 1;
                    partitionSection.subsections[0].items.push({
                        name: job.name,
                        rate: w,
                        quantity: nn,
                        unit: 'шт.',
                        total: (nn * w).toFixed(1)
                    });
                    return;
                }
                const q = parseFloat(job.quantity);
                const qq = (!isNaN(q) && q > 0) ? q : 1;
                partitionSection.subsections[0].items.push({
                    name: job.name,
                    rate: w,
                    quantity: qq.toFixed(1),
                    unit: 'кв.м.',
                    total: (qq * w).toFixed(1)
                });
                if (job.type === 'gypsumFrame') {
                    partitionSection.subsections[0].items.push({
                        name: 'Устройство теплозвукоизоляции',
                        rate: PARTITION_GYPSUM_FRAME_INSULATION_RATE,
                        quantity: qq.toFixed(1),
                        unit: 'кв.м.',
                        total: (qq * PARTITION_GYPSUM_FRAME_INSULATION_RATE).toFixed(1)
                    });
                }
            });
            if (partitionSection.subsections[0].items.length > 0) {
                sections.push(partitionSection);
            }
        }

        // 1. ЧИСТОВАЯ ОТДЕЛКА
        const finishingSection = {
            name: "ЧИСТОВАЯ ОТДЕЛКА",
            subsections: []
        };

        // Отделка стен (жилые): все отмеченные позиции + суммарная грунтовка
        if (hasLivingWallEstimateWorks(selectedMaterials)) {
            const wallItems = buildLivingWallsEstimateItems(selectedMaterials);
            if (wallItems.length > 0) {
                sections.push({
                    name: "ОТДЕЛКА СТЕН",
                    subsections: [{ name: "", items: wallItems }]
                });
            }
        }

        function getRoomsDataForSkirtingEstimate() {
            if (typeof getRoomsData === 'function') {
                try {
                    const rd = getRoomsData();
                    if (Array.isArray(rd) && rd.length) return rd;
                } catch (e) { /* ignore */ }
            }
            if (meta && Array.isArray(meta.roomsData) && meta.roomsData.length) return meta.roomsData;
            return [];
        }

        function skirtingPerimeterMFromRooms(roomsData) {
            const fallback = meta && meta.totalLivingArea != null ? meta.totalLivingArea : null;
            return skirtingPerimeterMFromRoomsData(roomsData, fallback);
        }

        function appendAdditionalLivingFloorItems(floorSection) {
            if (!floorSection || !floorSection.subsections || !floorSection.subsections[0] || !floorSection.subsections[0].items) return;
            if (!selectedMaterials.additionalFloors || !selectedMaterials.additionalFloors.length) return;
            selectedMaterials.additionalFloors.forEach(function (additionalMaterial) {
                if (!isLivingAdditionalFloor(additionalMaterial)) return;
                let additionalWorkRate = 0;
                let additionalWorkName = "";
                switch (additionalMaterial.type) {
                    case 'screed':
                        additionalWorkRate = 950;
                        additionalWorkName = (additionalMaterial.name && String(additionalMaterial.name).indexOf('санузел') >= 0)
                            ? 'Стяжка пола (санузел)'
                            : 'Стяжка пола';
                        break;
                    case 'selfLeveling':
                        additionalWorkRate = selfLevelingWorkRatePerSqm(additionalMaterial.thicknessMm);
                        additionalWorkName = (additionalMaterial.name && String(additionalMaterial.name).indexOf('санузел') >= 0)
                            ? 'Наливной пол (санузел)'
                            : 'Наливной пол';
                        break;
                    case 'skirting':
                        if (additionalMaterial.skirtingVariant === 'tile' || (additionalMaterial.name && String(additionalMaterial.name).indexOf('плитк') >= 0)) {
                            additionalWorkRate = 800;
                            additionalWorkName = 'Плинтус из плитки';
                        } else {
                            additionalWorkRate = 250;
                            additionalWorkName = 'Плинтус (пластиковый)';
                        }
                        break;
                    default:
                        additionalWorkRate = 0;
                        additionalWorkName = "Неизвестный дополнительный материал";
                        break;
                }
                if (additionalWorkRate <= 0) return;
                if (additionalMaterial.type === 'skirting') {
                    let totalPerimeter = parseSkirtingPerimeterFromMaterial(additionalMaterial);
                    if (!(totalPerimeter > 0)) {
                        totalPerimeter = skirtingPerimeterMFromRooms(getRoomsDataForSkirtingEstimate());
                    }
                    floorSection.subsections[0].items.push({
                        name: additionalWorkName,
                        rate: additionalWorkRate,
                        quantity: totalPerimeter.toFixed(1),
                        unit: "п.м.",
                        total: (totalPerimeter * additionalWorkRate).toFixed(1)
                    });
                } else {
                    const additionalArea = parseFloat(String(additionalMaterial.area || '').replace(' м²', '').replace(',', '.')) || 0;
                    floorSection.subsections[0].items.push({
                        name: additionalWorkName,
                        rate: additionalWorkRate,
                        quantity: additionalArea.toFixed(1),
                        unit: "кв.м.",
                        total: (additionalArea * additionalWorkRate).toFixed(1)
                    });
                }
            });
        }

        // Отделка полов (жилые): все отмеченные позиции + суммарная грунтовка
        if (hasLivingFloorEstimateWorks(selectedMaterials)) {
            const floorItems = buildLivingFloorsEstimateItems(selectedMaterials);
            const floorSection = {
                name: "НАПОЛЬНЫЕ ПОКРЫТИЯ",
                subsections: [{ name: "", items: floorItems }]
            };
            appendAdditionalLivingFloorItems(floorSection);
            if (floorSection.subsections[0].items.length > 0) {
                sections.push(floorSection);
            }
        }

        // Плиточные работы (детализированные разделы)
        const hasTrayInPlumbing = selectedMaterials.plumbing && selectedMaterials.plumbing.some(function(s) { return s.type === 'tray'; });
        const hasBfTray = Boolean(selectedMaterials.bathroomPorcelainTrayEnabled);
        if (hasBathroomFloorFinishWorks(selectedMaterials) || hasTrayInPlumbing || hasBfTray || hasBathroomWallEstimateWorks(selectedMaterials)) {
            // 1. САНУЗЕЛ ПОЛ (создаём при выборе пола санузла или поддона из керамогранита)
            if (hasBathroomFloorFinishWorks(selectedMaterials) || hasTrayInPlumbing || hasBfTray) {
                const bathFloorItems = buildBathroomFloorEstimateItems(selectedMaterials);

                const trayPlQty = hasTrayInPlumbing ? selectedMaterials.plumbing.reduce(function(sum, s) { return s.type === 'tray' ? sum + (parseInt(s.quantity, 10) || 1) : sum; }, 0) : 0;
                const trayQtyTotal = trayPlQty + (hasBfTray ? 1 : 0);
                if (trayQtyTotal > 0) {
                    bathFloorItems.push({
                        name: "Поддон из керамогранита",
                        rate: 15000,
                        quantity: trayQtyTotal,
                        unit: "шт.",
                        total: (trayQtyTotal * 15000).toFixed(1)
                    });
                }

                if (bathFloorItems.length > 0) {
                    sections.push({
                        name: "САНУЗЕЛ ПОЛ",
                        subsections: [{ name: "", items: bathFloorItems }]
                    });
                }
            }

            // 2. САНУЗЕЛ СТЕНЫ
            if (hasBathroomWallEstimateWorks(selectedMaterials)) {
                const wallItems = buildBathroomWallsEstimateItems(selectedMaterials);
                if (wallItems.length > 0) {
                    sections.push({
                        name: "САНУЗЕЛ СТЕНЫ",
                        subsections: [{ name: "", items: wallItems }]
                    });
                }
            }
        }

        // Отделка потолков
        if (selectedMaterials.ceilings && selectedMaterials.ceilings.length > 0) {
            const ceilingSection = {
                name: "ОТДЕЛКА ПОТОЛКОВ",
                subsections: [{
                    name: "",
                    items: []
                }]
            };

            // Берем площадь по первому типу (все типы работают по одной и той же площади)
            const ceilingMaterial = selectedMaterials.ceilings[0];
            const ceilingArea = parseFloat(ceilingMaterial.area.replace(' м²', '')) || 0;

            // Площадь потолков без санузлов
            let livingCeilingArea = ceilingArea;
            if (selectedMaterials.bathroomFloors) {
                const bathroomFloorArea = parseFloat(selectedMaterials.bathroomFloors.area.replace(' м²', '')) || 0;
                livingCeilingArea = ceilingArea - bathroomFloorArea;
            }

            const ceilingPrimerLayers = ceilingPrimerLayerCount(selectedMaterials.ceilings);
            if (ceilingPrimerLayers > 0 && livingCeilingArea > 0) {
                const primerQty = livingCeilingArea * ceilingPrimerLayers;
                ceilingSection.subsections[0].items.push({
                    name: ceilingPrimerName(ceilingPrimerLayers),
                    rate: ESTIMATE_RATE_PRIMER_SQM,
                    quantity: primerQty.toFixed(1),
                    unit: "кв.м.",
                    total: (primerQty * ESTIMATE_RATE_PRIMER_SQM).toFixed(1)
                });
            }

            // Для каждого выбранного типа потолка добавляем отдельную работу на ту же площадь
            selectedMaterials.ceilings.forEach(c => {
                let ceilingWorkRate = 0;
                let ceilingWorkName = "";
                
                switch(c.type) {
                    case 'stretch':
                        ceilingWorkRate = 900;
                        ceilingWorkName = "Устройство натяжных потолков";
                        break;
                    case 'paintCeiling':
                        ceilingWorkRate = 300;
                        ceilingWorkName = "Покраска потолков";
                        break;
                    case 'puttyCeiling':
                        ceilingSection.subsections[0].items.push({
                            name: "Шпаклёвка потолка (3 слоя)",
                            rate: 180,
                            quantity: (livingCeilingArea * 3).toFixed(1),
                            unit: "кв.м.",
                            total: (livingCeilingArea * 3 * 180).toFixed(1)
                        });
                        ceilingSection.subsections[0].items.push({
                            name: "Шлифовка потолка",
                            rate: 90,
                            quantity: livingCeilingArea.toFixed(1),
                            unit: "кв.м.",
                            total: (livingCeilingArea * 90).toFixed(1)
                        });
                        return;
                    case 'plasterCeiling':
                        ceilingWorkRate = 800;
                        ceilingWorkName = "Штукатурка потолков";
                        break;
                    case 'fabric':
                        ceilingWorkRate = 1200;
                        ceilingWorkName = "Устройство тканевых потолков";
                        break;
                    case 'armstrong':
                        ceilingWorkRate = 650;
                        ceilingWorkName = "Монтаж потолка Армстронг";
                        break;
                    default:
                        ceilingWorkRate = 0;
                        ceilingWorkName = "Неизвестный тип потолка";
                        break;
                }

                if (ceilingWorkRate > 0) {
                    ceilingSection.subsections[0].items.push({
                        name: ceilingWorkName,
                        rate: ceilingWorkRate,
                        quantity: livingCeilingArea.toFixed(1),
                        unit: "кв.м.",
                        total: (livingCeilingArea * ceilingWorkRate).toFixed(1)
                    });
                }
            });

            // Для натяжных потолков добавляем специальную обработку санузлов
            if (ceilingMaterial.type === 'stretch') {
                let bathroomCeilingArea = 0;
                if (selectedMaterials.bathroomFloors) {
                    bathroomCeilingArea = parseFloat(selectedMaterials.bathroomFloors.area.replace(' м²', '')) || 0;
                }
                if (bathroomCeilingArea > 0) {
                    ceilingSection.subsections[0].items.push({
                        name: "Устройство натяжных потолков по керамической плитке",
                        rate: 1000,
                        quantity: bathroomCeilingArea.toFixed(1),
                        unit: "кв.м.",
                        total: (bathroomCeilingArea * 1000).toFixed(1)
                    });
                }
            }


            sections.push(ceilingSection);
        }

        // Освещение
        if (selectedMaterials.lighting && selectedMaterials.lighting.length > 0) {
            const lightingSection = {
                name: "ОСВЕЩЕНИЕ",
                subsections: [{
                    name: "",
                    items: []
                }]
            };

            selectedMaterials.lighting.forEach(light => {
                let lightWorkRate = 0;
                let lightWorkName = "";
                
                switch(light.type) {
                    case 'spots':
                        lightWorkRate = 500;
                        lightWorkName = "Монтаж точечных светильников";
                        break;
                    case 'chandelier':
                        lightWorkRate = 1500;
                        lightWorkName = "Установка люстры";
                        break;
                    case 'led':
                        lightWorkRate = 1500;
                        lightWorkName = "Установка LED панелей";
                        break;
                    case 'track':
                        lightWorkRate = 1200;
                        lightWorkName = "Установка трековых светильников";
                        break;
                    case 'sconce':
                        lightWorkRate = 600;
                        lightWorkName = "Установка бра";
                        break;
                    case 'floor':
                        lightWorkRate = 1000;
                        lightWorkName = "Установка торшера";
                        break;
                }

                const lightQuantity = parseInt(light.quantity);
                lightingSection.subsections[0].items.push({
                    name: lightWorkName,
                    rate: lightWorkRate,
                    quantity: lightQuantity,
                    unit: "шт.",
                    total: (lightQuantity * lightWorkRate).toFixed(1)
                });
            });

            sections.push(lightingSection);
        }

        if (selectedMaterials.windowsDoors && selectedMaterials.windowsDoors.length > 0) {
            const wdSection = {
                name: "ОКНА И ДВЕРИ",
                subsections: [{
                    name: "",
                    items: []
                }]
            };
            selectedMaterials.windowsDoors.forEach(function (item) {
                const spec = WINDOWS_DOORS_WORK_RATES[item.type];
                if (!spec) return;
                const qty = parseInt(item.quantity, 10);
                if (isNaN(qty) || qty <= 0) return;
                wdSection.subsections[0].items.push({
                    name: spec.name,
                    rate: spec.rate,
                    quantity: qty,
                    unit: "шт.",
                    total: (qty * spec.rate).toFixed(1)
                });
            });
            if (wdSection.subsections[0].items.length > 0) {
                sections.push(wdSection);
            }
        }


        // 2. ЭЛЕКТРОМОНТАЖНЫЕ РАБОТЫ — только если выбрана хотя бы одна услуга
        if (selectedMaterials.electrical && selectedMaterials.electrical.length > 0) {
            const electricalSection = {
                name: "ЭЛЕКТРОМОНТАЖНЫЕ РАБОТЫ",
                subsections: [{
                    name: "",
                    items: []
                }]
            };

            let thermostatCountForWarmFloor = 0;
            (selectedMaterials.electrical || []).forEach(function (s) {
                if (s.type === 'thermostat') {
                    thermostatCountForWarmFloor += parseInt(s.quantity, 10) || 0;
                }
            });

            selectedMaterials.electrical.forEach(service => {
                    if (service.type === 'warmFloor') {
                        const area = parseFloat(service.quantity);
                        if (isNaN(area) || area <= 0) {
                            return;
                        }
                        const T = thermostatCountForWarmFloor;
                        /* N терморегуляторов: первые min(N,A) м² × 5000, остаток × 500. Без терморегулятора — как N=1: 1 м² × 5000, осталь по 500. */
                        const premiumZones = T >= 1 ? T : 1;
                        const premiumSqm = Math.min(premiumZones, area);
                        const extraSqm = Math.max(0, area - premiumZones);
                        const totalRub = premiumSqm * 5000 + extraSqm * 500;
                        const ratePerSqm = area > 0 ? totalRub / area : 0;
                        electricalSection.subsections[0].items.push({
                            name: 'Монтаж тёплого пола (электрического)',
                            rate: Math.round(ratePerSqm * 100) / 100,
                            quantity: area.toFixed(1),
                            unit: 'кв.м.',
                            total: totalRub.toFixed(1)
                        });
                        return;
                    }

                    let workRate = 0;
                    let workName = "";
                    
                    switch(service.type) {
                        case 'outlets':
                            workRate = 300;
                            workName = "Установка розеток";
                            break;
                        case 'switches':
                            workRate = 300;
                            workName = "Установка выключателей";
                            break;
                        case 'panel':
                            workRate = 3000;
                            workName = "Установка электрощитка";
                            break;
                        case 'breakers':
                            workRate = 800;
                            workName = "Установка автоматов";
                            break;
                        case 'exhaustfan':
                            workRate = 550;
                            workName = "Установка вытяжного вентилятора";
                            break;
                        case 'ceilingWiring':
                            workRate = 200;
                            workName = "Укладка проводов по потолку";
                            break;
                        case 'openCableLaying':
                            workRate = 200;
                            workName = "Прокладка кабеля (без штробления и заделки штроб)";
                            break;
                        case 'junctionBoxes':
                            workRate = 850;
                            workName = "Монтаж распределительных коробок";
                            break;
                        case 'outletChasing':
                            workRate = 650;
                            workName = "Штробление отверстий для подрозетников";
                            break;
                        case 'outletBoxes':
                            workRate = 150;
                            workName = "Установка подрозетников";
                            break;
                        case 'electricalChasing':
                            workRate = 350;
                            workName = "Штробление каналов под электропроводку";
                            break;
                        case 'wireLaying':
                            workRate = 350;
                            workName = "Укладка проводов в штробе с заделкой штробы";
                            break;
                        case 'thermostat':
                            workRate = 1200;
                            workName = "Установка терморегулятора";
                            break;
                        case 'electricTowelWarmer':
                            workRate = 1500;
                            workName = "Установка электрического полотенцесушителя";
                            break;
                        default:
                            workRate = 0;
                            workName = "Неизвестная услуга";
                            break;
                    }

                    // Добавляем услугу только если workRate > 0
                    if (workRate > 0) {
                        // Определяем единицу измерения для каждого типа услуги
                        let unit = 'шт.';
                        if (service.type === 'electricalChasing' || service.type === 'wireLaying' || service.type === 'ceilingWiring' || service.type === 'openCableLaying') {
                            unit = 'п.м.';
                        }

                        electricalSection.subsections[0].items.push({
                            name: workName,
                            rate: workRate,
                            quantity: service.quantity || 1,
                            unit: unit,
                            total: ((service.quantity || 1) * workRate).toFixed(1)
                        });
                    }
                });

            sections.push(electricalSection);
        }

        // 3. САНТЕХНИЧЕСКИЕ РАБОТЫ — услуги сантехмонтажа и/или поддон из керамогранита (слив без ГВ/ХВ)
        const hasTrayInPlumbingSvc = selectedMaterials.plumbing && selectedMaterials.plumbing.some(function (s) { return s.type === 'tray'; });
        const hasBfTrayPlumbing = Boolean(selectedMaterials.bathroomPorcelainTrayEnabled);
        const porcelainTrayInstallQty = (hasTrayInPlumbingSvc ? selectedMaterials.plumbing.reduce(function (sum, s) {
            return s.type === 'tray' ? sum + (parseInt(s.quantity, 10) || 1) : sum;
        }, 0) : 0) + (hasBfTrayPlumbing ? 1 : 0);
        if ((selectedMaterials.plumbing && selectedMaterials.plumbing.length > 0) || porcelainTrayInstallQty > 0) {
            const plumbingSection = {
                name: "САНТЕХНИЧЕСКИЕ РАБОТЫ",
                subsections: [{
                    name: "",
                    items: []
                }]
            };

            selectedMaterials.plumbing.forEach(service => {
                    let workRate = 0;
                    let workName = "";
                
                switch(service.type) {
                    case 'toilet':
                        workRate = 3500;
                        workName = "Установка унитаза (напольный)";
                        break;
                    case 'sink':
                        workRate = 2000;
                        workName = "Установка раковины";
                        break;
                    case 'bathtub':
                        workRate = 4000;
                        workName = "Установка ванны";
                        break;
                    case 'shower':
                        workRate = 12000;
                        workName = "Установка душевой кабины";
                        break;
                    case 'tray':
                        workRate = 0;
                        workName = "";
                        break;
                    case 'heating':
                        workRate = 10000;
                        workName = "Установка радиаторов отопления";
                        break;
                    case 'installation':
                        workRate = 5000;
                        workName = "Установка каркаса инсталляции";
                        break;
                    case 'gypsumBoxes':
                        workRate = 1900;
                        workName = "Устройство Коробов из гипсокартона(инсталяция)";
                        break;
                    case 'waterheater':
                        workRate = 2500;
                        workName = "Установка водонагревателя";
                        break;
                    case 'towelwarmer':
                        workRate = 2000;
                        workName = "Установка полотенцесушителя (водяной)";
                        break;
                    case 'glassdoors':
                        workRate = 2500;
                        workName = "Установка стеклянных дверок";
                        break;
                    case 'walltoilet':
                        workRate = 2500;
                        workName = "Установка подвесного унитаза";
                        break;
                    case 'mixers':
                        workRate = 1500;
                        workName = "Установка смесителей";
                        break;
                    case 'showersystem':
                        workRate = 3500;
                        workName = "Установка душевой системы";
                        break;
                    case 'washingmachine':
                        workRate = 1000;
                        workName = "Подключение стиральной машины";
                        break;
                    case 'sinkcabinet':
                        workRate = 3500;
                        workName = "Установка раковины с тумбой";
                        break;
                    case 'mirrors':
                        workRate = 800;
                        workName = "Навес зеркал, полок";
                        break;
                    case 'dishwasher':
                        workRate = 1000;
                        workName = "Подключение посудомоечной машины (кухня)";
                        break;
                    case 'kitchensink':
                        workRate = 2500;
                        workName = "Установка мойки (кухня)";
                        break;
                    case 'sololift':
                        workRate = 3000;
                        workName = "Установка санитарного насоса (Сололифт)";
                        break;
                    default:
                        workRate = 0;
                        workName = "Неизвестная услуга";
                        break;
                }

                // Добавляем услугу только если workRate > 0
                if (workRate > 0) {
                    plumbingSection.subsections[0].items.push({
                        name: workName,
                        rate: workRate,
                        quantity: service.quantity || 1,
                        unit: 'шт.',
                        total: ((service.quantity || 1) * workRate).toFixed(1)
                    });
                }
                
                // Если выбрана ванна, автоматически добавляем установку смесителя
                if (service.type === 'bathtub') {
                    plumbingSection.subsections[0].items.push({
                        name: "Установка смесителя в ванну",
                        rate: 2500,
                        quantity: service.quantity || 1,
                        unit: "шт.",
                        total: ((service.quantity || 1) * 2500).toFixed(1)
                    });
                }
                
                // Если выбрана раковина, автоматически добавляем установку смесителя
                if (service.type === 'sink') {
                    plumbingSection.subsections[0].items.push({
                        name: "Установка смесителя на раковину",
                        rate: 1500,
                        quantity: service.quantity || 1,
                        unit: "шт.",
                        total: ((service.quantity || 1) * 1500).toFixed(1)
                    });
                }
                
                // Если выбрана раковина с тумбой, автоматически добавляем установку смесителя
                if (service.type === 'sinkcabinet') {
                    plumbingSection.subsections[0].items.push({
                        name: "Установка смесителя на раковину",
                        rate: 1500,
                        quantity: service.quantity || 1,
                        unit: "шт.",
                        total: ((service.quantity || 1) * 1500).toFixed(1)
                    });
                }
            });

            // При выборе ванны или поддона из керамогранита — гидроизоляция стен 8 м² (если плитки на стенах СУ нет — в сантехработы)
            const hasBathtubInPlumbing = selectedMaterials.plumbing.some(function(s) { return s.type === 'bathtub'; });
            if ((hasBathtubInPlumbing || porcelainTrayInstallQty > 0) && !selectedMaterials.wallTile) {
                plumbingSection.subsections[0].items.push({
                    name: "Гидроизоляция стен",
                    rate: 300,
                    quantity: 8,
                    unit: "кв.м.",
                    total: (8 * 300).toFixed(1)
                });
            }

            if (porcelainTrayInstallQty > 0) {
                plumbingSection.subsections[0].items.push({
                    name: "Установка трапа",
                    rate: 1500,
                    quantity: porcelainTrayInstallQty,
                    unit: "шт.",
                    total: (porcelainTrayInstallQty * 1500).toFixed(1)
                });
            }

            // Добавляем автоматические услуги сантехмонтажа
            // Разводка узлов водоснабжения (зависит от выбранных приборов)
            let waterSupplyNodes = 0;
            if (selectedMaterials.plumbing && selectedMaterials.plumbing.length > 0) {
                selectedMaterials.plumbing.forEach(service => {
                    // Смесители требуют 2 узла (горячая + холодная вода)
                    if (service.type === 'mixers') {
                        waterSupplyNodes += (service.quantity || 1) * 2;
                    }
                    // Душевые требуют 2 узла (горячая + холодная вода); поддон — только слив, без ГВ/ХВ
                    else if (service.type === 'shower' || service.type === 'showersystem') {
                        waterSupplyNodes += (service.quantity || 1) * 2;
                    }
                    // Инсталляция требует 1 узел (холодная вода для унитаза)
                    else if (service.type === 'installation') {
                        waterSupplyNodes += service.quantity || 1;
                    }
                    // Водонагреватель требует 2 узла (вход холодной + выход горячей воды)
                    else if (service.type === 'waterheater') {
                        waterSupplyNodes += (service.quantity || 1) * 2;
                    }
                    // Стиральная машина требует 1 узел (только холодная вода)
                    else if (service.type === 'washingmachine') {
                        waterSupplyNodes += service.quantity || 1;
                    }
                    // Посудомойка (кухня): 1 узел (холодная вода)
                    else if (service.type === 'dishwasher') {
                        waterSupplyNodes += service.quantity || 1;
                    }
                    // Мойка (кухня): 2 узла (горячая + холодная вода)
                    else if (service.type === 'kitchensink') {
                        waterSupplyNodes += (service.quantity || 1) * 2;
                    }
                    // Напольный унитаз требует 1 узел (холодная вода)
                    else if (service.type === 'toilet') {
                        waterSupplyNodes += service.quantity || 1;
                    }
                    // Раковина автоматически добавляет смеситель (2 узла водоснабжения)
                    else if (service.type === 'sink') {
                        waterSupplyNodes += (service.quantity || 1) * 2;
                    }
                    // Раковина с тумбой — смеситель на раковину (2 узла ГВ+ХВ), как у раковины
                    else if (service.type === 'sinkcabinet') {
                        waterSupplyNodes += (service.quantity || 1) * 2;
                    }
                    // Ванна автоматически добавляет смеситель (2 узла водоснабжения)
                    else if (service.type === 'bathtub') {
                        waterSupplyNodes += (service.quantity || 1) * 2;
                    }
                    // Радиатор и полотенцесушитель — подвод/обратка (2 узла)
                    else if (service.type === 'heating' || service.type === 'towelwarmer') {
                        waterSupplyNodes += (service.quantity || 1) * 2;
                    }
                });
            } else {
                waterSupplyNodes = 0;
            }

            /* Разводка и штробление — только при ненулевом числе узлов (зеркала, полотенцесушитель, дверки, радиатор без канализации). */
            if ((selectedMaterials.plumbing && selectedMaterials.plumbing.length > 0) || hasBfTrayPlumbing) {
                let sewerageNodes = 0;
                const hasInstallationForSewer = selectedMaterials.plumbing.some(function (s) { return s.type === 'installation'; });
                selectedMaterials.plumbing.forEach(service => {
                    if (service.type === 'walltoilet' && hasInstallationForSewer) {
                        return;
                    }
                    if (service.type === 'sink' || service.type === 'sinkcabinet' || service.type === 'bathtub' ||
                        service.type === 'installation' || service.type === 'shower' || service.type === 'showersystem' || service.type === 'tray' ||
                        service.type === 'washingmachine' || service.type === 'toilet' ||
                        service.type === 'dishwasher' || service.type === 'kitchensink' || service.type === 'sololift') {
                        sewerageNodes += service.quantity || 1;
                    }
                });
                if (hasBfTrayPlumbing) {
                    sewerageNodes += 1;
                }

                if (waterSupplyNodes > 0) {
                    plumbingSection.subsections[0].items.push({
                        name: "Разводка узлов горячего и холодного водоснабжения",
                        rate: 2500,
                        quantity: waterSupplyNodes,
                        unit: "шт.",
                        total: (waterSupplyNodes * 2500).toFixed(1)
                    });
                }

                const hasBathtubForPipeChasing = selectedMaterials.plumbing && selectedMaterials.plumbing.some(function (s) {
                    return s && s.type === 'bathtub';
                });
                if (hasBathtubForPipeChasing || porcelainTrayInstallQty > 0) {
                    plumbingSection.subsections[0].items.push({
                        name: "Штробление с замазкой стен под трубу 2 х 22мм (кирпич)",
                        rate: 1000,
                        quantity: 3.2,
                        unit: "п.м.",
                        total: (3.2 * 1000).toFixed(1)
                    });
                }

                if (sewerageNodes > 0) {
                    plumbingSection.subsections[0].items.push({
                        name: "Разводка узлов канализации",
                        rate: 1500,
                        quantity: sewerageNodes,
                        unit: "шт.",
                        total: (sewerageNodes * 1500).toFixed(1)
                    });
                }
            }

            sections.push(plumbingSection);
        }

        // 4. ГИПСОКАРТОН
        const gypsumSection = {
            name: "ГИПСОКАРТОН",
            subsections: [{
                name: "",
                items: []
            }]
        };

        // Раздел «Гипсокартон» не включает короба под инсталляцию — они перенесены в «Санузел стены»
        // Добавляем раздел гипсокартона только если появятся другие услуги гипсокартона
        if (gypsumSection.subsections[0].items.length > 0) {
            sections.push(gypsumSection);
        }

        // 5. ДОПОЛНИТЕЛЬНЫЕ И ПРОЧИЕ РАБОТЫ
        const additionalSection = {
            name: "ДОПОЛНИТЕЛЬНЫЕ И ПРОЧИЕ РАБОТЫ",
            subsections: [{
                name: "",
                items: []
            }]
        };

        // Вынос мусора: при любых работах в смете — строка всегда; кол-во мешков по нормам зон (плитка/керамогранит — ⌈S/5⌉ и др.)
        const GARBAGE_REMOVAL_RATE = 80;
        let workItemsBeforeAdditional = 0;
        sections.forEach(function (section) {
            section.subsections.forEach(function (subsection) {
                workItemsBeforeAdditional += subsection.items.length;
            });
        });
        if (workItemsBeforeAdditional > 0) {
            const garbageBagQty = meta.lastCalc
                ? computeMusorBagCount(selectedMaterials, meta.lastCalc)
                : 0;
            additionalSection.subsections[0].items.push({
                name: "Вынос мусора и остатков материалов в мешках",
                rate: GARBAGE_REMOVAL_RATE,
                quantity: String(garbageBagQty),
                unit: "шт.",
                total: (garbageBagQty * GARBAGE_REMOVAL_RATE).toFixed(1)
            });
        }

        if (additionalSection.subsections[0].items.length > 0) {
            sections.push(additionalSection);
        }

        // Подсчитываем общую стоимость
        sections.forEach(section => {
            section.subsections.forEach(subsection => {
                subsection.items.forEach(item => {
                    totalCost += parseFloat(item.total);
                });
            });
        });

        return { sections, total: totalCost, documentTitle: documentTitle, address: rawAddr };
    }
    function getBasketProducts(lastCalc, ch) {
        const calc = lastCalc;
        function getPlanRoomCountForLampKit(lc) {
            if (!lc) return 1;
            let n = 0;
            if (Array.isArray(lc.roomWallsDetails)) n += lc.roomWallsDetails.length;
            if (lc.bathroomCalc && Array.isArray(lc.bathroomCalc.details)) n += lc.bathroomCalc.details.length;
            return n > 0 ? n : 1;
        }
        /* Лампа/патрон: только при «основных» позициях электрики. Не при одном только терморегуляторе: для него добавляются штробление/каналы (outletChasing…wireLaying), их не считаем триггером лампы. */
        const EL_LAMP_KIT_SCOPE_TYPES = new Set([
            'outlets', 'switches', 'junctionBoxes', 'panel', 'breakers', 'ceilingWiring'
        ]);
        const stage = {}; // этапы 2..10, каждый Map id -> qty
        for (let s = 2; s <= 10; s++) stage[s] = new Map();

        const wallArea = calc.totalWallArea || 0;
        let wallMaterialArea = wallArea;
        if (selectedMaterials.walls && selectedMaterials.walls.area) {
            const w = parseAreaStringToSqm(selectedMaterials.walls.area);
            if (w != null) wallMaterialArea = w;
        }
        const plasterWallItem = selectedMaterials.additionalWalls && selectedMaterials.additionalWalls.find(m => m.type === 'plaster');
        let wallPlasterMaterialArea = wallMaterialArea;
        if (plasterWallItem && plasterWallItem.area) {
            const pw = parseAreaStringToSqm(plasterWallItem.area);
            if (pw != null) wallPlasterMaterialArea = pw;
        }
        let wallPuttyMaterialArea = wallMaterialArea;
        if (selectedMaterials.wallPuttyAreaM2 != null && selectedMaterials.wallPuttyAreaM2 > 0) {
            wallPuttyMaterialArea = selectedMaterials.wallPuttyAreaM2;
        }
        const ceilingArea = calc.totalCeilingArea || 0;
        let livingCeilingSqm = ceilingArea;
        if (selectedMaterials.bathroomFloors && selectedMaterials.bathroomFloors.area) {
            const bathFloorSqForCeil = parseAreaStringToSqm(selectedMaterials.bathroomFloors.area);
            if (bathFloorSqForCeil != null && bathFloorSqForCeil > 0) {
                livingCeilingSqm = Math.max(0, ceilingArea - bathFloorSqForCeil);
            }
        }
        const laminateArea = calc.materials.laminate || 0;
        const floorTileArea = calc.materials.floorTile || 0;
        const wallTileArea = calc.materials.wallTile || 0;
        const totalFloorLiving = laminateArea;
        let livingWallTileForBasket = 0;
        if (selectedMaterials.wallsVariants && selectedMaterials.wallsVariants.length) {
            livingWallTileForBasket = sumTileLayingAreaFromVariants(selectedMaterials.wallsVariants, wallMaterialArea);
        } else if (selectedMaterials.walls && isTileLayingType(selectedMaterials.walls.type)) {
            const wallTileSq = selectedMaterials.walls.area ? parseAreaStringToSqm(selectedMaterials.walls.area) : null;
            livingWallTileForBasket = (wallTileSq != null && wallTileSq > 0) ? wallTileSq : wallMaterialArea;
        }
        /* Клей этапа 7: только если в справочнике отмечены соответствующие работы — не от плана «втихаря» */
        let apronTileSqmForGlue = 0;
        if (selectedMaterials.additionalWalls && selectedMaterials.additionalWalls.length) {
            selectedMaterials.additionalWalls.forEach(function (m) {
                if (m.type === 'ceramicGraniteApron' && m.area) {
                    const sq = parseAreaStringToSqm(m.area);
                    if (sq != null && sq > 0) apronTileSqmForGlue += sq;
                }
            });
        }
        const bathFloorTileForGlue = sumTileLayingAreaFromVariants(getBathroomFloorFinishVariants(selectedMaterials), floorTileArea);
        const bathWallTileForGlue = sumTileLayingAreaFromVariants(getBathroomWallTileVariants(selectedMaterials), wallTileArea);
        const tileTotalArea = bathFloorTileForGlue + bathWallTileForGlue + livingWallTileForBasket + apronTileSqmForGlue;

        const hasElectricalForMaterials = (selectedMaterials.electrical || []).length > 0;
        const electricalIsOnlyCeilingWiring = hasElectricalForMaterials
            && (selectedMaterials.electrical || []).every(s => s.type === 'ceilingWiring');
        const electricalIsOnlyBreakers = hasElectricalForMaterials
            && (selectedMaterials.electrical || []).every(s => s.type === 'breakers');
        const hasElLampKitScope = (selectedMaterials.electrical || []).some(s => EL_LAMP_KIT_SCOPE_TYPES.has(s.type));
        const hasPlumbingForMaterials = (selectedMaterials.plumbing || []).length > 0;
        const hasDemolition = (selectedMaterials.demolition || []).length > 0;
        let pgbPartitionSqm = 0;
        let foamPartitionSqm = 0;
        let brickPartitionSqm = 0;
        let gypsumFramePartitionSqm = 0;
        let gypsumFrameLivingWallSqm = 0;
        (selectedMaterials.partitions || []).forEach(function (p) {
            if (!p || p.quantity == null || String(p.quantity).trim() === '') return;
            const sq = parseFloat(String(p.quantity).replace(/\s/g, '').replace(',', '.'));
            if (isNaN(sq) || sq <= 0) return;
            if (p.type === 'pgb') pgbPartitionSqm += sq;
            if (p.type === 'foam') foamPartitionSqm += sq;
            if (p.type === 'brick') brickPartitionSqm += sq;
            if (p.type === 'gypsumFrame') gypsumFramePartitionSqm += sq;
        });
        if (selectedMaterials.walls && selectedMaterials.walls.type === 'gypsumFrame' && wallMaterialArea > 0) {
            gypsumFrameLivingWallSqm = wallMaterialArea;
        }
        const gypsumFrameScopeSqm = gypsumFramePartitionSqm + gypsumFrameLivingWallSqm;
        /* Перегородки: ПГП / ГКЛ каркас — этап 7; пеноблок/кирпич — этап 6 + addPartitionPgpLikeAccessories; дюбель-гвоздь 84038798 — при ПГП, пеноблоке, кирпиче или ГКЛ на каркасе. */
        const hasHeavyPartitionForSharedStages = false;
        const hasDemolitionOrPartitionsForStage2 = hasDemolition || hasHeavyPartitionForSharedStages;
        const hasWallFinishScope = Boolean(
            selectedMaterials.walls
            || (selectedMaterials.wallsVariants && selectedMaterials.wallsVariants.length > 1)
            || (selectedMaterials.additionalWalls && selectedMaterials.additionalWalls.length > 0)
        );
        /* СТ17 этап 6: штукатурка/шпаклёvka/плитка; не обои/покраска (Радуга-27), не ГКЛ и не панели ПВХ. */
        const hasPartitionScopeForStage6WallPrimer = hasHeavyPartitionForSharedStages;
        const hasBathroomFloorScope = Boolean(selectedMaterials.bathroomFloors);
        const hasBathPlasterUnderTileSprav = selectedMaterials.additionalWallTile && selectedMaterials.additionalWallTile.some(function (m) { return m.type === 'plaster'; });
        const hasBathroomWallTileScope = Boolean(selectedMaterials.wallTile) || hasBathPlasterUnderTileSprav;
        const wallSqForStage6Primer = computeTotalWallLivingPrimerSqm(selectedMaterials)
            + (hasPartitionScopeForStage6WallPrimer ? wallMaterialArea : 0);
        const floorTileSqForPrimer = hasBathroomFloorScope ? floorTileArea : 0;
        let wallTileSqForPrimerVal = wallTileArea;
        if (hasBathPlasterUnderTileSprav) {
            const bpPr = selectedMaterials.additionalWallTile && selectedMaterials.additionalWallTile.find(function (m) { return m.type === 'plaster'; });
            const pSq = bpPr && bpPr.area ? parseAreaStringToSqm(bpPr.area) : null;
            if (pSq != null && pSq > 0) wallTileSqForPrimerVal = pSq;
        }
        const wallTileSqForPrimer = hasBathroomWallTileScope && wallTileSqForPrimerVal > 0 ? wallTileSqForPrimerVal : 0;
        const hasWallPlaster = selectedMaterials.additionalWalls && selectedMaterials.additionalWalls.some(m => m.type === 'plaster');
        const hasWallPuttySprav = selectedMaterials.additionalWalls && selectedMaterials.additionalWalls.some(function (m) { return isWallPuttySpravType(m.type); });
        const hasWallPuttyPaintSprav = selectedMaterials.additionalWalls && selectedMaterials.additionalWalls.some(function (m) { return m.type === 'puttyPaint'; });

        const ceilingHeight = (typeof ch === 'number' && ch > 0) ? ch : (parseFloat(ch) || 2.7);
        const perimeter = 4 * Math.sqrt(ceilingArea); // приближённый периметр по площади потолка
        const plasterWallPerimeter = ceilingHeight > 0 ? wallPlasterMaterialArea / ceilingHeight : (wallPlasterMaterialArea > 0 ? 4 * Math.sqrt(wallPlasterMaterialArea) : 0);

        function add(stageNum, id, qty) {
            if (qty > 0) {
                const m = stage[stageNum];
                m.set(String(id), (m.get(String(id)) || 0) + Math.max(1, Math.ceil(qty)));
            }
        }
        /** Число маяков по длине установки (м): шаг 1,2 м, округление вверх — как в add(16126441, …). */
        function beaconsQtyFromRunM(runM) {
            if (!(runM > 0)) return 0;
            return Math.ceil(runM / 1.2);
        }
        const MUSHROOM_DOWEL_SKU = '84038798';
        const MUSHROOM_DOWEL_PER_PACK = 500;
        function mushroomDowelPcsForPerimeterM(perimeterM) {
            if (!(perimeterM > 0)) return 0;
            return Math.ceil(perimeterM * 2);
        }
        function mushroomDowelPacksFromPcs(pcs) {
            if (!(pcs > 0)) return 0;
            return Math.ceil(pcs / MUSHROOM_DOWEL_PER_PACK);
        }
        function mushroomDowelPacksFromPerimeterM(perimeterM) {
            return mushroomDowelPacksFromPcs(mushroomDowelPcsForPerimeterM(perimeterM));
        }
        /** Длина пристеночного/направляющего профиля перегородки (верх + низ): 2×(S/h). */
        function partitionTrackPerimeterM(partitionSqm) {
            if (!(partitionSqm > 0) || !(ceilingHeight > 0)) return 0;
            return 2 * (partitionSqm / ceilingHeight);
        }
        function skirtingPerimeterMFromCalc(c) {
            let totalP = skirtingPerimeterMFromCalcObj(c);
            if (totalP <= 0) {
                (selectedMaterials.additionalFloors || []).forEach(function (m) {
                    if (!m || m.type !== 'skirting') return;
                    const p = parseSkirtingPerimeterFromMaterial(m);
                    if (p > 0) totalP = p;
                });
            }
            if (totalP <= 0) {
                (selectedMaterials.additionalFloors || []).forEach(function (m) {
                    if (!m || m.type !== 'skirting' || !m.area) return;
                    const sq = parseAreaStringToSqm(m.area);
                    if (sq != null && sq > 0) totalP += floorPerimeterMFromAreaSqm(sq);
                });
            }
            return totalP;
        }
        function mushroomDowelQtyInStages() {
            let qSum = 0;
            for (let st = 2; st <= 10; st++) {
                const q = stage[st].get(MUSHROOM_DOWEL_SKU);
                if (q) qSum += q;
            }
            return qSum;
        }

        const PARTITION_ACCESSORY_STAGE = 7;
        const PARTITION_IF_ABSENT_TOOLS = [
            { sku: 89437391, stage: 6 },
            { sku: 89445192, stage: 8 },
            { sku: 89445233, stage: 8 },
            { sku: 82798222, stage: 8 },
            { sku: 13653975, stage: 8 },
            { sku: 12893977, stage: 8 },
            { sku: 15369329, stage: 8 },
            { sku: 12757510, stage: 6 },
            { sku: 88993426, stage: 6 },
            { sku: 16126433, stage: 8 },
            { sku: 89407217, stage: 6 },
            { sku: 89374069, stage: 6 }
        ];
        const PORCELAIN_TRAY_IF_ABSENT_TOOLS = [
            { sku: 89437391, stage: 6 },
            { sku: 89445192, stage: 8 },
            { sku: 89445233, stage: 8 },
            { sku: 13653975, stage: 8 },
            { sku: 17517621, stage: 8 },
            { sku: 17496815, stage: 6 },
            { sku: 89374069, stage: 6 }
        ];

        function partitionSkuQtyInStages(sku) {
            let qSum = 0;
            const skuStr = String(sku);
            for (let st = 2; st <= 10; st++) {
                const q = stage[st].get(skuStr);
                if (q) qSum += q;
            }
            return qSum;
        }

        /** ППН/подвесы — только ПГП/пеноблок/кирпич; пена/мешки/расходники — опционально (для ГКЛ на каркасе без ППН/подвесов). */
        function addPartitionPgpLikeAccessories(partitionSqm, options) {
            options = options && typeof options === 'object' ? options : {};
            if (!(partitionSqm > 0)) return;
            if (!options.skipPgpSuspensionKit) {
                add(PARTITION_ACCESSORY_STAGE, 12902474, 2);
                const partRunM = ceilingHeight > 0 ? partitionSqm / ceilingHeight : 0;
                add(PARTITION_ACCESSORY_STAGE, 14394434, partRunM > 0 ? partRunM / 0.5 : partitionSqm * 2);
            }
            if (partitionSkuQtyInStages('89432387') === 0) add(PARTITION_ACCESSORY_STAGE, 89432387, 1);
            if (partitionSkuQtyInStages('89394761') === 0) add(PARTITION_ACCESSORY_STAGE, 89394761, 1);
            if (partitionSkuQtyInStages('82909816') === 0) add(PARTITION_ACCESSORY_STAGE, 82909816, 1);
            add(PARTITION_ACCESSORY_STAGE, 17968499, Math.max(1, Math.ceil(partitionSqm / 30)));
            PARTITION_IF_ABSENT_TOOLS.forEach(function (row) {
                if (partitionSkuQtyInStages(row.sku) === 0) add(row.stage, row.sku, 1);
            });
        }

        let totalOutlets = 0;
        let totalSwitches = 0;
        let totalThermostats = 0;
        (selectedMaterials.electrical || []).forEach(function (s) {
            const q = parseInt(s.quantity, 10) || 1;
            if (s.type === 'outlets') totalOutlets += q;
            if (s.type === 'switches') totalSwitches += q;
            if (s.type === 'thermostat') totalThermostats += q;
        });

        // ЭТАП 2 — демонтаж (demo-wall / demo-floor / demo-linoleum / demo-wallpaper / demo-paint; перегородки — отдельно, не этап 2)
        if (hasDemolitionOrPartitionsForStage2) {
            [88022833, 82303712, 86407837].forEach(id => add(2, id, 1));
            if (demolitionNeedsKesContainer(selectedMaterials.demolition)) {
                add(2, 86759162, 1); // Ёмкость КЭС 60 л — не при демонтаже линолеума / обоев / краски
            }
            add(2, 89340784, 5);   // Перчатки хлопчатобумажные 68072 V2 размер единый, 5 пар — 5 шт по стандарту
            add(2, 89437391, 2); // Ведро Лемана Про 10 л — 2 шт по стандарту
        }
        if (hasDemolition) {
            /* Мешки для мусора 17968499 (уп. 10 шт.): по каждому виду демонтажа ⌈м²/6⌉ уп., площади суммируются в корзине */
            let demolitionMusorBagPacks = 0;
            (selectedMaterials.demolition || []).forEach(function (job) {
                if (!job || job.quantity == null) return;
                let sq = typeof job.quantity === 'number'
                    ? job.quantity
                    : parseAreaStringToSqm(String(job.quantity));
                if (isNaN(sq) || sq <= 0) return;
                demolitionMusorBagPacks += demolitionMusorBagPacksFromSqm(job.type, sq);
            });
            if (demolitionMusorBagPacks > 0) add(2, 17968499, demolitionMusorBagPacks);
            add(2, 86262884, 1); // Мешки тканевые для пылесоса Dexter NJTV0069JD01 30 л, уп. 4 шт.
        }

        // ЭТАП 3 — электромонтаж: кабель/подрозетники по розеткам, выключателям и терморегуляторам (без эл.полотенцесушителя — в корзине не конфигурируется)
        const outletsSwitchesCount = totalOutlets + totalSwitches + totalThermostats;

        // Кабель на отрез: 3×2.5 мм² для розеток и терморегуляторов (2.5 м на точку), 3×1.5 мм² для выключателей (2 м на выключатель)
        if (totalOutlets + totalThermostats > 0) add(3, 81933629, (totalOutlets + totalThermostats) * 2.5);   // Кабель ВВГпнг 3х2.5
        if (totalSwitches > 0) add(3, 81933623, totalSwitches * 2);   // Кабель ВВГпнг 3х1.5 — выключатели
        if ((selectedMaterials.electrical || []).some(s => s.type === 'breakers')) {
            add(3, 81933630, 1);   // Камкабель ВВГпнг(A)-LS 3×4 на отрез ГОСТ — 1 м при «Установка автоматов»
        }
        const ceilingCableM = selectedMaterials.ceilingCableM;
        if (ceilingCableM && typeof ceilingCableM === 'object') {
            CEILING_WIRING_CABLE_SKUS.forEach(function (sku) {
                const m = parseFloat(ceilingCableM[sku]);
                if (!isNaN(m) && m > 0) add(3, sku, m);
            });
        }

        // Дюбель-хомут 81975734 и стяжка 89454656 — только при розетках / выключателях / терморегуляторе / проводке по потолку; 2 шт на п.м. провода, уп. 100 шт
        let wireCeilingM = 0;
        (selectedMaterials.electrical || []).forEach(function (s) {
            if (s.type === 'ceilingWiring') {
                const q = parseFloat(s.quantity, 10);
                if (!isNaN(q) && q > 0) wireCeilingM += q;
            }
        });
        const wireGrooveM = (totalOutlets + totalThermostats) * 2.5 + totalSwitches * 2;
        const wireTotalM = wireGrooveM + wireCeilingM;
        const elCableClampScope = totalOutlets > 0 || totalSwitches > 0 || totalThermostats > 0 || wireCeilingM > 0;
        if (elCableClampScope && wireTotalM > 0) {
            const pcs = wireTotalM * 2;
            const packs100 = Math.ceil(pcs / 100);
            add(3, 81975734, packs100);
            add(3, 89454656, packs100);
        }

        // Лампочка 86270629 и патрон 82432247 — по числу комнат плана (вкл. санузлы) при розетках/выключателях/распредкоробках/щите/автоматах/проводке по потолку (не при одном только терморегуляторе); бур 82909816 — 2 шт. при любом электромонтаже; изолента 12463053 — после расчёта этапов (см. ниже)
        if (hasElLampKitScope) {
            const lampKitRooms = getPlanRoomCountForLampKit(calc);
            add(3, 86270629, lampKitRooms);
            add(3, 82432247, lampKitRooms);
        }
        if (hasElectricalForMaterials) {
            add(3, 82909816, 2); // Бур по бетону SDS-plus 6x42x110 мм
        }
        // Клеммы Duwi 84509784: 3 шт на каждую точку (розетка / выключатель / терморегулятор), в упаковке 5 шт — число упаковок в корзину
        const clampPoints = totalOutlets + totalSwitches + totalThermostats;
        if (clampPoints > 0) {
            add(3, 84509784, Math.ceil((clampPoints * 3) / 5));
        }
        const breakerSkuIds = [18072264, 18072272, 18072299, 18072301, 18072328, 18072408, 18072504, 18072512];
        const bxSku = selectedMaterials.breakerExtraBySku;
        const hasBxSku = bxSku && typeof bxSku === 'object' && !Array.isArray(bxSku) && Object.keys(bxSku).length > 0;
        if (hasBxSku) {
            breakerSkuIds.forEach(id => {
                const q = parseInt(bxSku[String(id)], 10) || parseInt(bxSku[id], 10) || 0;
                if (q > 0) add(3, id, q);
            });
            /* 82209659: шина на 12 модулей; сумма по всем автоматическим выключателям из первой таблицы (BA47/VA47), без АВДТ. */
            const mcbCombBusSkuIds = [18072264, 18072272, 18072299, 18072301, 18072328, 18072408];
            let sumMcbForBus = 0;
            mcbCombBusSkuIds.forEach(id => {
                const q = parseInt(bxSku[String(id)], 10) || parseInt(bxSku[id], 10) || 0;
                if (q > 0) sumMcbForBus += q;
            });
            if (sumMcbForBus > 0) {
                add(3, 82209659, Math.ceil(sumMcbForBus / 12));
            }
        }
        // Распределительные коробки LEXMAN 85x85x40 мм — по количеству при выборе услуги
        (selectedMaterials.electrical || []).forEach(s => {
            if (s.type === 'junctionBoxes') add(3, 87964079, parseInt(s.quantity, 10) || 1);
        });

        // Подрозетники: под бетон — по количеству розеток + выключателей + терморегуляторов, под гипсокартон — 1 шт по стандарту
        if (outletsSwitchesCount > 0) add(3, 13353198, outletsSwitchesCount); // Подрозетник под бетон
        if (hasElectricalForMaterials && !electricalIsOnlyBreakers) add(3, 13353411, 1); // Подрозетник под гипсокартон — 1 шт по стандарту (не при одних только автоматах)

        // ЭТАП 4 — общий фикс (Сантехмонтаж → plumb-fix4; не при других сантехуслугах без этой галочки)
        if (selectedMaterials.stage4GeneralFix) {
            [86533760, 86853122, 15603381, 15603373, 82173821, 82173838, 82173845, 82173887, 82173914, 82173932].forEach(id => add(4, id, 1));
            add(4, 82173879, 10);   // Заглушка РТП 20 мм полипропилен — 10 шт по стандарту
            add(4, 82173865, 10);   // Муфта РТП 20 мм полипропилен — 10 шт по стандарту
            [85104807, 81952904, 81952884, 81952842, 81952838, 81952835].forEach(id => add(4, id, 1));
        }

        const plumbingOnlyInstallation = (selectedMaterials.plumbing || []).some(function (s) { return s.type === 'installation'; })
            && (selectedMaterials.plumbing || []).every(function (s) { return s.type === 'installation' || s.type === 'walltoilet'; });

        // ЭТАП 4 — сантехмонтаж (комплекты по выбранным услугам)
        if (hasPlumbingForMaterials) {

        // Комплект при выборе ванны: сифон, планка, обвод, тройники, труба, углы, заглушки, крепёж, отвод/заглушка/труба канализации 50 мм
        const bathtubCount = (selectedMaterials.plumbing || []).reduce((sum, s) => s.type === 'bathtub' ? sum + (parseInt(s.quantity, 10) || 1) : sum, 0);
        if (bathtubCount > 0) {
            add(4, 18551011, 1);      // Сифон для ванны Equation с выпуском с ревизией
            add(4, 82173878, 1);      // Планка монтажная 1/2"х20 мм ВР полипропилен
            add(4, 82173883, 1);      // Обвод РТП 20 мм полипропилен
            add(4, 82173900, 2);      // Тройник РТП 20 мм полипропилен
            add(4, 89423944, 2);      // Труба полипропиленовая MONLID 20x3.4 мм SDR6 PN25 2 м
            add(4, 82173933, 4);      // Угол 90° РТП 20 мм полипропилен
            add(4, 11348723, 2);      // Крепеж двойной для полипропиленовой трубы 20 мм
            add(4, 81952836, 1);      // Отвод 50 мм 45° полипропилен
            add(4, 81952831, 1);      // Заглушка Ростурпласт 50 мм полипропилен
            add(4, 81952827, 1);      // Труба для внутренней канализации РТП 50x1.8 мм 1 м полипропилен
            add(4, 12761130, bathtubCount * 2);  // Заглушка РВК 1/2" НР ВП полипропилен 030202 — 2 шт при ванне
            add(4, 84858780, bathtubCount);      // Хомут для труб Mayer 1 1/2" 48-53 мм со шпилькой и дюбелем
        }

        // Гидроизоляция стен санузла 8 м² при ванне или поддоне керамогранита без плитки на стенах
        if (!selectedMaterials.wallTile) {
            let hydroCans = bathtubCount;
            if (hasPorcelainTrayScope(selectedMaterials)) hydroCans += 1;
            if (hydroCans > 0) add(4, 14182298, hydroCans);   // Glims GreenRezin 7 кг
        }

        // Комплект при выборе раковины/раковины с тумбой: тройник 50x40x50, крепёж, заглушки, трубы канализации, сифон, муфты, труба MONLID, обвод, подводки
        const sinkCount = (selectedMaterials.plumbing || []).reduce((sum, s) => (s.type === 'sink' || s.type === 'sinkcabinet') ? sum + (parseInt(s.quantity, 10) || 1) : sum, 0);
        if (sinkCount > 0) {
            add(4, 81952840, sinkCount);     add(4, 11348723, sinkCount * 2); add(4, 81952831, sinkCount); add(4, 81952827, sinkCount); add(4, 81952825, sinkCount);
            add(4, 18551054, sinkCount);    add(4, 82173822, sinkCount * 2); add(4, 89423944, sinkCount); add(4, 82173883, sinkCount); add(4, 82661642, sinkCount * 2);
            add(4, 12761122, sinkCount * 2); add(4, 84858780, sinkCount);
        }

        const showerCount = (selectedMaterials.plumbing || []).reduce((sum, s) => s.type === 'shower' ? sum + (parseInt(s.quantity, 10) || 1) : sum, 0);
        if (showerCount > 0) {
            add(4, 81952840, showerCount);     add(4, 11348723, showerCount * 2); add(4, 81952831, showerCount); add(4, 81952827, showerCount); add(4, 81952825, showerCount);
            add(4, 82173822, showerCount * 2); add(4, 89423944, showerCount); add(4, 82173883, showerCount); add(4, 82661642, showerCount * 2);
            add(4, 12761122, showerCount * 2); add(4, 84858780, showerCount);
        }

        const waterheaterCount = (selectedMaterials.plumbing || []).reduce((sum, s) => s.type === 'waterheater' ? sum + (parseInt(s.quantity, 10) || 1) : sum, 0);
        if (waterheaterCount > 0) {
            add(4, 89423944, waterheaterCount * 2); add(4, 82173900, waterheaterCount); add(4, 82173933, waterheaterCount * 2);
            add(4, 82173822, waterheaterCount * 2); add(4, 82173883, waterheaterCount); add(4, 11348723, waterheaterCount * 2);
            add(4, 12761122, waterheaterCount * 2);
        }

        const showerSystemCount = (selectedMaterials.plumbing || []).reduce((sum, s) => s.type === 'showersystem' ? sum + (parseInt(s.quantity, 10) || 1) : sum, 0);

        // Комплект при выборе стиральной или посудомоечной машины
        const washingMachineCount = (selectedMaterials.plumbing || []).reduce((sum, s) => s.type === 'washingmachine' ? sum + (parseInt(s.quantity, 10) || 1) : sum, 0);
        const dishwasherCount = (selectedMaterials.plumbing || []).reduce((sum, s) => s.type === 'dishwasher' ? sum + (parseInt(s.quantity, 10) || 1) : sum, 0);
        const washerDishwasherCount = washingMachineCount + dishwasherCount;
        if (washerDishwasherCount > 0) {
            add(4, 89423944, washerDishwasherCount); add(4, 82173900, washerDishwasherCount); add(4, 89376015, washerDishwasherCount);
            add(4, 81952840, washerDishwasherCount); add(4, 81952831, washerDishwasherCount); add(4, 81952827, washerDishwasherCount);
            add(4, 88041437, washerDishwasherCount); add(4, 12761130, washerDishwasherCount); add(4, 82173914, washerDishwasherCount); add(4, 84858780, washerDishwasherCount);  // Заглушка РВК 1/2" НР ВП 030202 — по 1 шт на стиральную/посудомойку
        }

        const kitchensinkCount = (selectedMaterials.plumbing || []).reduce((sum, s) => s.type === 'kitchensink' ? sum + (parseInt(s.quantity, 10) || 1) : sum, 0);
        const allToiletCount = plumbingOnlyInstallation
            ? (selectedMaterials.plumbing || []).reduce((sum, s) => s.type === 'toilet' ? sum + (parseInt(s.quantity, 10) || 1) : sum, 0)
            : (selectedMaterials.plumbing || []).reduce((sum, s) => (s.type === 'toilet' || s.type === 'walltoilet') ? sum + (parseInt(s.quantity, 10) || 1) : sum, 0);
        const totalTaps = sinkCount * 2 + kitchensinkCount * 2 + allToiletCount
            + waterheaterCount * 2 + showerSystemCount * 2;
        if (totalTaps > 0) add(4, 89416049, totalTaps);   // Кран шаровой прямой MONLID PN40 1/2" НР/ВР

        if (kitchensinkCount > 0) {
            add(4, 82173822, kitchensinkCount * 2); add(4, 82661642, kitchensinkCount * 2); add(4, 81952827, kitchensinkCount); add(4, 81952840, kitchensinkCount);
            add(4, 81952831, kitchensinkCount); add(4, 81952838, kitchensinkCount * 2); add(4, 82173883, kitchensinkCount); add(4, 82173933, kitchensinkCount * 4);
            add(4, 11348723, kitchensinkCount * 2); add(4, 12761122, kitchensinkCount * 2); add(4, 84858780, kitchensinkCount);
        }

        const toiletCount = (selectedMaterials.plumbing || []).reduce((sum, s) => s.type === 'toilet' ? sum + (parseInt(s.quantity, 10) || 1) : sum, 0);
        if (toiletCount > 0) {
            add(4, 89423944, toiletCount); add(4, 82173933, toiletCount * 2); add(4, 82173822, toiletCount); add(4, 82173900, toiletCount); add(4, 81952919, toiletCount);
            add(4, 89409383, toiletCount); add(4, 81952888, toiletCount); add(4, 81952906, toiletCount); add(4, 81952883, toiletCount); add(4, 89418702, toiletCount);
            add(4, 81952831, toiletCount); add(4, 12761122, toiletCount); add(4, 84858785, toiletCount); add(4, 89376094, toiletCount);
        }

        const installationCount = (selectedMaterials.plumbing || []).reduce((sum, s) => s.type === 'installation' ? sum + (parseInt(s.quantity, 10) || 1) : sum, 0);
        if (installationCount > 0) {
            add(4, 81952905, installationCount); add(4, 81952919, installationCount); add(4, 81952888, installationCount);
            add(4, 81952831, installationCount); add(4, 82173879, installationCount); // Заглушка РТП 20 мм полипропилен
            add(4, 89423944, installationCount * 2); add(4, 82173933, installationCount * 2);
            add(4, 82173900, installationCount); add(4, 82194897, installationCount); add(4, 84858785, installationCount);
        }

        const sololiftCount = (selectedMaterials.plumbing || []).reduce((sum, s) => s.type === 'sololift' ? sum + (parseInt(s.quantity, 10) || 1) : sum, 0);
        if (sololiftCount > 0) {
            add(4, '18746741', sololiftCount); // Труба Ростерм Aqua 40×5.5 мм SDR 7.4 PN 20, 2 м — 1 шт. на каждый сололифт
            add(4, '82194825', 3); // Крепёж Valfex 40 мм полипропилен — 3 шт. при выборе сололифта
        }

        } // hasPlumbingForMaterials — этап 4

        // ЭТАП 5 — отопление (материалы при необходимости из этапа 4)

        // ЭТАП 6 — черновые: грунтовка по площади (0.15 л/м², банка 10 л)
        // Площади в корзину только по отмеченным в справочнике позициям (стены/санузел/пол жилой), без «тихого» учёта всей квартиры из плана.
        // Жилой пол: без выбора покрытия в справочнике ламинат из плана в groundArea не включается; при выборе пола — отдельный add ниже.
        const livingFloorFinishVariants = getLivingFloorFinishVariants(selectedMaterials);
        const hasLivingFloorCovering = livingFloorFinishVariants.length > 0;
        let livingFloorSqmForCt17 = 0;
        livingFloorFinishVariants.forEach(function (f) {
            livingFloorSqmForCt17 += livingFloorVariantSqm(f, laminateArea);
        });
        /* Грунтовка пола в смете: floorPrimerLayerCount (1 на стяжку + 1 на наливной). */
        const floorPrimerLayersForCt17 = floorPrimerLayerCount(selectedMaterials.additionalFloors, hasLivingFloorCovering);
        const livingFloorInGroundArea = 0;
        const groundArea = wallSqForStage6Primer + livingFloorInGroundArea + floorTileSqForPrimer + wallTileSqForPrimer;
        add(6, 12757510, groundArea * 0.015); // Грунтовка Церезит СТ17 10 л
        if (hasLivingFloorCovering && livingFloorSqmForCt17 > 0) {
            add(6, 12757510, livingFloorSqmForCt17 * floorPrimerLayersForCt17 * 0.015); // СТ17 под жилой пол — сумма площадей покрытий × слои
        }
        if (!hasLivingFloorCovering && selectedMaterials.additionalFloors && selectedMaterials.additionalFloors.length > 0) {
            let extraFloorSqmForCt17 = 0;
            selectedMaterials.additionalFloors.forEach(function (m) {
                if (m.type !== 'screed' && m.type !== 'selfLeveling') return;
                const sq = livingAdditionalFloorAreaSqm(m);
                if (sq > extraFloorSqmForCt17) extraFloorSqmForCt17 = sq;
            });
            if (extraFloorSqmForCt17 > 0) {
                add(6, 12757510, extraFloorSqmForCt17 * floorPrimerLayersForCt17 * 0.015); // стяжка/наливной без покрытия в модалке — как смета «только доп. полы»
            }
        }
        const hasCeilingPaintForRaduga = selectedMaterials.ceilings && selectedMaterials.ceilings.some(c => c.type === 'paintCeiling');
        let radugaLiters = 0;
        const radugaWallpaperPaintSqm = computeRadugaWallpaperPaintSqm(selectedMaterials);
        if (radugaWallpaperPaintSqm > 0) radugaLiters += radugaWallpaperPaintSqm * 0.015;
        const radugaDecorativeSqm = computeRadugaDecorativeWallSqm(selectedMaterials);
        if (radugaDecorativeSqm > 0) radugaLiters += radugaDecorativeSqm * 0.015;
        if (hasCeilingPaintForRaduga && ceilingArea > 0) radugaLiters += ceilingArea * 0.015;
        if (radugaLiters > 0) add(6, 12037193, radugaLiters); // Пропитка Радуга-27 — обои / покраска / дек. штукатурка стен + покраска потолка

        /* Крепежи маяков (штук.): на 1 маяк 6 шт. — дюбели 84039780 (уп.); саморезы на вес — отдельно по зонам */
        let beaconFastenerPiecesWallPlaster = 0;
        let beaconFastenerPiecesScreed = 0;
        /* Штукатурка стен (в т.ч. только справочник walls-plaster без чистовой отделки стен) — Ротбанд и маяки по площади */
        if (hasWallPlaster) {
            const plasterThickFactor = layerThicknessQtyFactor(plasterWallItem && plasterWallItem.thicknessMm, LAYER_THICKNESS_BASE_MM.plaster);
            add(6, 10073940, wallPlasterMaterialArea * 12.75 / 30 * plasterThickFactor);
            const plasterBeaconQty = beaconsQtyFromRunM(plasterWallPerimeter);
            add(6, 16126441, plasterBeaconQty); add(6, 15534291, (plasterBeaconQty * 6) / 25);
            beaconFastenerPiecesWallPlaster += plasterBeaconQty * 6;
            add(6, 89468179, 1); // Емкость для смешивания Matrix 65 л
        }
        /* Штукатурка под плитку в санузле — тот же расчёт Ротбанда и маяков, что у штукатурки стен (этап 6), площадь из подраздела bw-plaster или из плана */
        let bathPlasterUnderTileSqm = 0;
        if (hasBathPlasterUnderTileSprav) {
            const bpIt = selectedMaterials.additionalWallTile.find(function (m) { return m.type === 'plaster'; });
            if (bpIt && bpIt.area) {
                const bps = parseAreaStringToSqm(bpIt.area);
                if (bps != null && bps > 0) bathPlasterUnderTileSqm = bps;
            }
        }
        if (bathPlasterUnderTileSqm <= 0 && wallTileArea > 0) {
            bathPlasterUnderTileSqm = wallTileArea;
        }
        if (hasBathPlasterUnderTileSprav && bathPlasterUnderTileSqm > 0) {
            const bpItRot = selectedMaterials.additionalWallTile && selectedMaterials.additionalWallTile.find(function (m) { return m.type === 'plaster'; });
            const bathPlasterThickFactor = layerThicknessQtyFactor(bpItRot && bpItRot.thicknessMm, LAYER_THICKNESS_BASE_MM.plaster);
            add(6, 10073940, bathPlasterUnderTileSqm * 12.75 / 30 * bathPlasterThickFactor);
            const bathPlasterPerimeter = ceilingHeight > 0 ? bathPlasterUnderTileSqm / ceilingHeight : (bathPlasterUnderTileSqm > 0 ? 4 * Math.sqrt(bathPlasterUnderTileSqm) : 0);
            const bathBeaconQty = beaconsQtyFromRunM(bathPlasterPerimeter);
            add(6, 16126441, bathBeaconQty); add(6, 15534291, (bathBeaconQty * 6) / 25);
            beaconFastenerPiecesWallPlaster += bathBeaconQty * 6;
        }
        if (selectedMaterials.walls && selectedMaterials.walls.type !== 'panels' && selectedMaterials.walls.type !== 'gypsumFrame') {
            const isTileWall = selectedMaterials.walls.type === 'tile' || selectedMaterials.walls.type === 'porcelain';
            const isDecorativeWall = selectedMaterials.walls.type === 'decorative';
            if (!hasWallPlaster && !isTileWall && !isDecorativeWall && !hasWallpaperWallScope(selectedMaterials)) {
                add(6, 10073940, 1);
            }
        }
        if (hasWallPuttySprav && wallPuttyMaterialArea > 0) {
            add(6, 89283063, wallPuttyMaterialArea * 1 / 20);
            if (hasWallPuttyPaintSprav) {
                add(6, 89434298, wallPuttyMaterialArea / 18);
            }
            addPuttySandingSponges(add, 6, wallPuttyMaterialArea);
        }

        if (selectedMaterials.additionalFloors && selectedMaterials.additionalFloors.length > 0) {
            selectedMaterials.additionalFloors.forEach(m => {
                const area = livingAdditionalFloorAreaSqm(m);
                const selfThickF = layerThicknessQtyFactor(m.thicknessMm, LAYER_THICKNESS_BASE_MM.selfLeveling);
                const screedThickF = layerThicknessQtyFactor(m.thicknessMm, LAYER_THICKNESS_BASE_MM.screed);
                if (m.type === 'selfLeveling' && area > 0) {
                    add(6, 13857230, area / 2 * selfThickF);
                    if (selfLevelingEffectiveThicknessMm(m.thicknessMm) > 10) {
                        add(6, '88698314', dampingTapeRollsFromFloorAreaSqm(area));
                    }
                }
                if (m.type === 'screed' && area > 0) {
                    add(6, 15163419, area * 4 * screedThickF);
                    const screedPerimeter = floorPerimeterMFromAreaSqm(area);
                    const screedBeaconQty = beaconsQtyFromRunM(screedPerimeter);
                    add(6, 16126441, screedBeaconQty); add(6, 15534291, (screedBeaconQty * 6) / 25);
                    beaconFastenerPiecesScreed += screedBeaconQty * 6;
                    add(6, '88698314', dampingTapeRollsFromFloorAreaSqm(area));
                }
            });
        }
        if (selectedMaterials.additionalBathroomFloors && selectedMaterials.additionalBathroomFloors.length > 0) {
            selectedMaterials.additionalBathroomFloors.forEach(m => {
                const area = livingAdditionalFloorAreaSqm(m);
                const selfThickF = layerThicknessQtyFactor(m.thicknessMm, LAYER_THICKNESS_BASE_MM.selfLeveling);
                const screedThickF = layerThicknessQtyFactor(m.thicknessMm, LAYER_THICKNESS_BASE_MM.screed);
                if (m.type === 'selfLeveling' && area > 0) {
                    add(6, 13857230, area / 2 * selfThickF);
                    if (selfLevelingEffectiveThicknessMm(m.thicknessMm) > 10) {
                        add(6, '88698314', dampingTapeRollsFromFloorAreaSqm(area));
                    }
                }
                if (m.type === 'screed' && area > 0) {
                    add(6, 15163419, area * 4 * screedThickF);
                    const screedPerimeter = floorPerimeterMFromAreaSqm(area);
                    const screedBeaconQty = beaconsQtyFromRunM(screedPerimeter);
                    add(6, 16126441, screedBeaconQty); add(6, 15534291, (screedBeaconQty * 6) / 25);
                    beaconFastenerPiecesScreed += screedBeaconQty * 6;
                    add(6, '88698314', dampingTapeRollsFromFloorAreaSqm(area));
                }
            });
        }
        const hasSelfLevelingFloors = (selectedMaterials.additionalFloors || []).some(m => m.type === 'selfLeveling');
        const hasSelfLevelingBathroom = (selectedMaterials.additionalBathroomFloors || []).some(m => m.type === 'selfLeveling');
        if (hasSelfLevelingFloors || hasSelfLevelingBathroom) add(6, 12005431, 1);

        const hasScreedForStage6AluRules = (selectedMaterials.additionalFloors || []).some(function (m) {
            return m.type === 'screed' && (parseFloat((m.area || '').toString().replace(' м²', '')) || 0) > 0;
        }) || (selectedMaterials.additionalBathroomFloors || []).some(function (m) {
            return m.type === 'screed' && (parseFloat((m.area || '').toString().replace(' м²', '')) || 0) > 0;
        });
        const hasPlasterCeilingSprav = selectedMaterials.ceilings && selectedMaterials.ceilings.some(function (c) { return c.type === 'plasterCeiling'; });
        const hasSkirtingSprav = (selectedMaterials.additionalFloors || []).some(function (m) { return m.type === 'skirting'; });
        /* Шпатели фасадные Hansa — по 1 шт. при любой штукатурке (стены жилые, под плитку СУ, потолок) */
        if (hasWallPlaster || hasBathPlasterUnderTileSprav || hasPlasterCeilingSprav) {
            add(6, 89410456, 1);
            add(6, 89410454, 1);
        }

        const hasStage6FixPack = hasWallFinishScope || hasBathroomFloorScope || hasBathroomWallTileScope || hasHeavyPartitionForSharedStages || Boolean(selectedMaterials.floors)
            || (selectedMaterials.additionalFloors && selectedMaterials.additionalFloors.length)
            || (selectedMaterials.additionalBathroomFloors && selectedMaterials.additionalBathroomFloors.length)
            || (selectedMaterials.ceilings && selectedMaterials.ceilings.length)
            || hasWallPlaster
            || hasWallPuttySprav
            || hasSelfLevelingFloors
            || hasSelfLevelingBathroom;
        const additionalFloorsOnlySkirting = (selectedMaterials.additionalFloors || []).length > 0
            && (selectedMaterials.additionalFloors || []).every(function (m) { return m.type === 'skirting'; });
        const skipBroomPencilForSkirtingOnlyProject = Boolean(
            hasSkirtingSprav
            && additionalFloorsOnlySkirting
            && !selectedMaterials.floors
            && !(selectedMaterials.additionalBathroomFloors && selectedMaterials.additionalBathroomFloors.length)
            && !(selectedMaterials.ceilings && selectedMaterials.ceilings.length)
            && !hasWallFinishScope
            && !hasBathroomFloorScope
            && !hasBathroomWallTileScope
            && !hasHeavyPartitionForSharedStages
            && !hasWallPlaster
            && !hasWallPuttySprav
            && !hasSelfLevelingFloors
            && !hasSelfLevelingBathroom
        );
        /* Саморезы на вес (кг в корзине ЛМ, не штуки): 87093280 — штукатурка стен/СУ; 87093283 — стяжка. Дюбели 84039780 — ⌈крепежей/50⌉ уп. */
        const beaconFastenerPiecesTotal = beaconFastenerPiecesWallPlaster + beaconFastenerPiecesScreed;
        if (beaconFastenerPiecesTotal > 0) {
            add(6, 84039780, beaconFastenerPiecesTotal / 50);
        }
        if (beaconFastenerPiecesWallPlaster > 0) {
            add(6, 87093280, beaconScrewKgFromPieces(beaconFastenerPiecesWallPlaster, BEACON_SCREW_35151_KG_PER_1000));
        }
        if (beaconFastenerPiecesScreed > 0) {
            add(6, 87093283, beaconScrewKgFromPieces(beaconFastenerPiecesScreed, BEACON_SCREW_4270_KG_PER_1000));
        }
        if (hasStage6FixPack) {
            if (!skipBroomPencilForSkirtingOnlyProject) {
                [17496815, 89374069].forEach(function (id) { add(6, id, 1); });
            }
            /* Перчатки 89407217 при фикс-наборе — не из этого ряда, если отмечен плинтус: тогда только блок «плинтус» ниже (диск + перчатки + дюбель). */
            if (!hasSkirtingSprav) {
                add(6, 89407217, 1);
            }
            /* Правила 88993423/88993426 — только при штукатурке: жилые стены (additionalWalls plaster), штукатурка под плитку в санузле (additionalWallTile plaster), и/или стяжке (доп. полы жилых/санузла, площадь > 0). */
            if (hasWallPlaster || hasBathPlasterUnderTileSprav || hasScreedForStage6AluRules) {
                [88993423, 88993426].forEach(id => add(6, id, 1));
            }
        }

        const plasterScreedSelfLevelMusorBags = computePlasterScreedSelfLevelMusorBags(selectedMaterials);
        const porcelainTrayMusorBags = computePorcelainTrayMusorBags(selectedMaterials);
        const stage6MusorBags = plasterScreedSelfLevelMusorBags + porcelainTrayMusorBags;
        if (stage6MusorBags > 0) {
            add(6, 17968499, stage6MusorBags / MUSOR_BAGS_PER_PACK);
        }

        // ЭТАП 7 — плиточные: по площади санузла + плитка на полу жилых комнат
        let livingFloorTileArea = 0;
        if (selectedMaterials.floorsVariants && selectedMaterials.floorsVariants.length) {
            livingFloorTileArea = sumTileLayingAreaFromVariants(selectedMaterials.floorsVariants, laminateArea);
        } else if (selectedMaterials.floors && isTileLayingType(selectedMaterials.floors.type)) {
            livingFloorTileArea = parseFloat((selectedMaterials.floors.area || '').toString().replace(' м²', '')) || laminateArea;
        }
        const totalTileArea = tileTotalArea + livingFloorTileArea;

        const hasStage8ToolsScope = totalTileArea > 0
            || hasWallFinishScope
            || hasHeavyPartitionForSharedStages
            || Boolean(selectedMaterials.floors)
            || (selectedMaterials.ceilings && selectedMaterials.ceilings.length > 0)
            || (selectedMaterials.additionalFloors && selectedMaterials.additionalFloors.length)
            || (selectedMaterials.additionalBathroomFloors && selectedMaterials.additionalBathroomFloors.length)
            || hasBathroomFloorScope
            || hasBathroomWallTileScope;
        const hasStage8ToolsScopeWithoutLivingFloors = totalTileArea > 0
            || hasWallFinishScope
            || hasHeavyPartitionForSharedStages
            || (selectedMaterials.ceilings && selectedMaterials.ceilings.length > 0)
            || (selectedMaterials.additionalFloors && selectedMaterials.additionalFloors.length)
            || (selectedMaterials.additionalBathroomFloors && selectedMaterials.additionalBathroomFloors.length)
            || hasBathroomFloorScope
            || hasBathroomWallTileScope;
        const stage8ToolPackOnlyFromLivingFloors = Boolean(selectedMaterials.floors) && !hasStage8ToolsScopeWithoutLivingFloors;

        /* Кисти Dexter 50 / 100 мм: по 1 шт. при грунтовке (СТ17 по площади), покраске стен/потолка или обоях — только если артикула ещё нет в корзине по этапам 2–10 */
        const hasCeilingPrimingBrush = ceilingPrimerLayerCount(selectedMaterials.ceilings || []) > 0 && livingCeilingSqm > 0;
        const hasPrimingWorkForBrush = groundArea > 0
            || (selectedMaterials.floors && livingFloorSqmForCt17 > 0)
            || hasCeilingPrimingBrush;
        const hasWallpaperForBrush = hasWallpaperWallScope(selectedMaterials) && wallMaterialArea > 0;
        const hasWallPaintForBrush = Boolean(selectedMaterials.walls && selectedMaterials.walls.type === 'paint' && wallMaterialArea > 0);
        const hasDecorativeWallForBrush = hasDecorativeWallScope(selectedMaterials) && computeRadugaDecorativeWallSqm(selectedMaterials) > 0;
        const hasCeilingPaintForBrush = Boolean(hasCeilingPaintForRaduga && ceilingArea > 0);
        const hasPaintBrushScope = hasPrimingWorkForBrush || hasWallpaperForBrush || hasWallPaintForBrush || hasDecorativeWallForBrush || hasCeilingPaintForBrush;

        let mosaicSqm = 0;
        let nonMosaicSqm = 0;
        getBathroomWallTileVariants(selectedMaterials).forEach(function (wt) {
            if (!wt || !isTileLayingType(wt.type)) return;
            const sq = wt.area ? parseAreaStringToSqm(wt.area) : null;
            const a = (sq != null && sq > 0) ? sq : wallTileArea;
            if (wt.type === 'mosaic') mosaicSqm += a;
            else nonMosaicSqm += a;
        });
        getBathroomFloorFinishVariants(selectedMaterials).forEach(function (bf) {
            if (!bf || !isTileLayingType(bf.type)) return;
            const sq = bf.area ? parseAreaStringToSqm(bf.area) : null;
            const a = (sq != null && sq > 0) ? sq : floorTileArea;
            if (bf.type === 'mosaic') mosaicSqm += a;
            else nonMosaicSqm += a;
        });
        nonMosaicSqm += livingWallTileForBasket + apronTileSqmForGlue;
        if (selectedMaterials.floorsVariants && selectedMaterials.floorsVariants.length) {
            selectedMaterials.floorsVariants.forEach(function (f) {
                if (!f || !isTileLayingType(f.type)) return;
                const sq = f.area ? parseAreaStringToSqm(f.area) : null;
                const a = (sq != null && sq > 0) ? sq : livingFloorTileArea;
                if (f.type === 'mosaic') mosaicSqm += a;
                else nonMosaicSqm += a;
            });
        } else if (selectedMaterials.floors && isTileLayingType(selectedMaterials.floors.type)) {
            if (selectedMaterials.floors.type === 'mosaic') mosaicSqm += livingFloorTileArea;
            else nonMosaicSqm += livingFloorTileArea;
        }

        if (totalTileArea > 0) {
            const regularTileGlueSqm = Math.max(0, totalTileArea - mosaicSqm);
            if (regularTileGlueSqm > 0) {
                add(7, 14886543, regularTileGlueSqm * 5 / 25);
            }
            add(7, 10977309, totalTileArea / 4); add(7, 81933319, 1); add(7, 82372585, 1);
            if (mosaicSqm > 0) {
                add(7, 11169661, mosaicGlueBagsFromSqm(mosaicSqm));
                add(7, 81947846, 1); // Гладилка Intek 4×4 — мозаика
            }
            /* 86220370, 15649363, 15649371, 605125 — см. блок ниже: мин. 1 шт., если артикула ещё нет в корзине по этапам */
        }
        /* Сверла копьевидные по керамике Neolaser 6/8/10 мм — только при работах с плиткой в справочнике */
        if (hasTileWorkScope(selectedMaterials)) {
            [89424572, 89424578, 89424579].forEach(function (id) { add(7, id, 1); });
        }
        const tileMusorBags = tileMusorBagsFromAreaSqm(ceramicPorcelainTileAreaSqm(selectedMaterials, calc))
            + mosaicMusorBagsFromSqm(mosaicTileAreaSqm(selectedMaterials, calc));
        if (tileMusorBags > 0) {
            add(7, 17968499, tileMusorBags / MUSOR_BAGS_PER_PACK);
        }

        /* Короб ГКЛ: санузел (additionalWallTile type box, шт.) + перегородка gypsumBox (шт.; листы ⌈N/2⌉ — 1 лист на 2 короба). Ранее перегородка задавалась м² → N=⌈м²/2⌉; для старых данных без unit «шт.» сохраняется пересчёт из м². ППН/ПП на короб; листы 10072745 (Knauf влагостойкий) — санузел и перегородки. */
        let gypsumBoxBathUnits = 0;
        if (selectedMaterials.additionalWallTile && selectedMaterials.additionalWallTile.length > 0) {
            const boxMat = selectedMaterials.additionalWallTile.find(m => m.type === 'box');
            if (boxMat && boxMat.quantity > 0) {
                const q = parseInt(boxMat.quantity, 10);
                if (!isNaN(q) && q > 0) gypsumBoxBathUnits += q;
            }
        }
        let gypsumBoxPartitionUnits = 0;
        const gypsumBoxPart = (selectedMaterials.partitions || []).find(p => p.type === 'gypsumBox');
        if (gypsumBoxPart) {
            if (gypsumBoxPart.unit === 'шт.') {
                const nb = parseInt(String(gypsumBoxPart.quantity), 10);
                if (!isNaN(nb) && nb > 0) gypsumBoxPartitionUnits += nb;
            } else {
                const sqm = parseFloat(String(gypsumBoxPart.quantity || '').replace(',', '.')) || 0;
                if (sqm > 0) gypsumBoxPartitionUnits += Math.max(1, Math.ceil(sqm / 2));
            }
        }
        const gypsumBoxUnitCount = gypsumBoxBathUnits + gypsumBoxPartitionUnits;
        const GYPSUM_BOX_PP_1500_SKU = '18734926';
        const GYPSUM_BOX_SHEET_SKU = '10072745';
        if (gypsumBoxUnitCount > 0) {
            add(7, 12902474, gypsumBoxUnitCount * 2);
            add(7, GYPSUM_BOX_PP_1500_SKU, gypsumBoxUnitCount);
            if (gypsumBoxBathUnits > 0) {
                add(7, GYPSUM_BOX_SHEET_SKU, Math.ceil(gypsumBoxBathUnits / 2));
            }
            if (gypsumBoxPartitionUnits > 0) {
                add(7, GYPSUM_BOX_SHEET_SKU, Math.ceil(gypsumBoxPartitionUnits / 2));
            }
        }

        /* Ротбанд и маяки под штукатурку стен санузла — этап 6 (см. блок hasBathPlasterUnderTileSprav выше). */

        /* ППН 12902474 (3 м): плитка / керамогранит / мозаика на стенах — по периметру помещений плана (как в плане: 4×√S пола комнаты), шт. = ⌈периметр / 3⌉; суммируется с профилем под короб ГКЛ (см. выше). Фартук без полной облицовки жилых стен — по длине фартука (L), где Sфартука = L×0.60. */
        function planRoomFloorPerimeterM(floorAreaSqm) {
            const a = parseFloat(floorAreaSqm);
            if (isNaN(a) || a <= 0) return 0;
            return 4 * Math.sqrt(a);
        }
        let ppnPerimeterWallTileM = 0;
        const wtForPpn = selectedMaterials.wallTile;
        const hasBathWallTileForPpn = Boolean(wtForPpn && ['tile', 'ceramic', 'porcelain', 'mosaic'].includes(wtForPpn.type));
        if (livingWallTileForBasket > 0 && calc && Array.isArray(calc.roomWallsDetails)) {
            calc.roomWallsDetails.forEach(function (r) {
                ppnPerimeterWallTileM += planRoomFloorPerimeterM(r.area);
            });
        }
        if (hasBathWallTileForPpn && calc && calc.bathroomCalc && Array.isArray(calc.bathroomCalc.details)) {
            calc.bathroomCalc.details.forEach(function (d) {
                const fa = d.area != null ? d.area : d.floorArea;
                ppnPerimeterWallTileM += planRoomFloorPerimeterM(fa);
            });
        }
        if (apronTileSqmForGlue > 0 && livingWallTileForBasket <= 0) {
            const apronLengthM = apronTileSqmForGlue / 0.6;
            ppnPerimeterWallTileM += apronLengthM;
        }
        if (ppnPerimeterWallTileM > 0) {
            add(7, 12902474, ppnPerimeterWallTileM / 3);
        }

        const hasPlasterWorkForCornerProfile = Boolean(
            hasWallPlaster
            || hasBathPlasterUnderTileSprav
            || (selectedMaterials.ceilings && selectedMaterials.ceilings.some(function (c) { return c.type === 'plasterCeiling'; }))
            || (selectedMaterials.walls && selectedMaterials.walls.type === 'plaster' && wallMaterialArea > 0)
        );
        const hasPuttyWorkForCornerProfile = Boolean(
            hasWallPuttySprav
            || (selectedMaterials.ceilings && selectedMaterials.ceilings.some(function (c) { return c.type === 'puttyCeiling'; }))
        );
        const hasDecorativeWallScopeFlag = hasDecorativeWallScope(selectedMaterials);
        const hasGypsumFrameLivingWallScope = Boolean(
            selectedMaterials.walls && selectedMaterials.walls.type === 'gypsumFrame' && wallMaterialArea > 0
        );
        const hasArmstrongCeilingSprav = Boolean(
            selectedMaterials.ceilings && selectedMaterials.ceilings.some(function (c) { return c.type === 'armstrong'; })
        );
        const STAGE8_OMIT_FOR_ARMSTRONG_CEILING = [89402327, 89432387, 89394761, 15369329, 87712166, 82586216, 89419395];
        const STAGE8_OMIT_FOR_CEILING_PAINT = [89402327, 89432387, 89394761];

        function additionalFloorsHasScreedOrSelfLeveling(arr) {
            if (!arr || !arr.length) return false;
            return arr.some(function (m) {
                if (!m || (m.type !== 'screed' && m.type !== 'selfLeveling')) return false;
                const sq = parseAreaStringToSqm(m.area);
                return sq != null && sq > 0;
            });
        }
        function additionalFloorsHasSelfLeveling(arr) {
            if (!arr || !arr.length) return false;
            return arr.some(function (m) {
                if (!m || m.type !== 'selfLeveling') return false;
                const sq = parseAreaStringToSqm(m.area);
                return sq != null && sq > 0;
            });
        }
        const omitFoamGunForScreedOrSelfLeveling = additionalFloorsHasScreedOrSelfLeveling(selectedMaterials.additionalFloors)
            || additionalFloorsHasScreedOrSelfLeveling(selectedMaterials.additionalBathroomFloors);
        const omitSealantGunForSelfLeveling = additionalFloorsHasSelfLeveling(selectedMaterials.additionalFloors)
            || additionalFloorsHasSelfLeveling(selectedMaterials.additionalBathroomFloors);

        // ЭТАП 8 — отделочные (инструмент по 1; набор Matrix 13653975 — после расчёта СТ17; губки шлифовальные — этап 6/10 при шпаклёвке)
        if (hasStage8ToolsScope) {
            const stage8OmitWhenOnlyLivingFloors = [89402327, 89432387, 89394761];
            const stage8FoamGunSku = [89432387, 89394761];
            const stage8SealantGunSku = [89402327];
            let stage8CoreToolIds = [15369329, 89419395, 89402327, 89432387, 89394761, 85579724, 17517621];
            if (shouldOmitStage8FoamGun(selectedMaterials, mosaicSqm)) {
                stage8CoreToolIds = stage8CoreToolIds.filter(function (id) { return stage8FoamGunSku.indexOf(id) === -1; });
            }
            if (omitFoamGunForScreedOrSelfLeveling) {
                stage8CoreToolIds = stage8CoreToolIds.filter(function (id) { return stage8FoamGunSku.indexOf(id) === -1; });
            }
            if (omitSealantGunForSelfLeveling || hasDecorativeWallScopeFlag || hasGypsumFrameLivingWallScope || hasPuttyWorkForCornerProfile || hasWallpaperWallScope(selectedMaterials)) {
                stage8CoreToolIds = stage8CoreToolIds.filter(function (id) { return stage8SealantGunSku.indexOf(id) === -1; });
            }
            if (hasArmstrongCeilingSprav) {
                stage8CoreToolIds = stage8CoreToolIds.filter(function (id) {
                    return STAGE8_OMIT_FOR_ARMSTRONG_CEILING.indexOf(id) === -1;
                });
            }
            if (hasCeilingPaintForRaduga) {
                stage8CoreToolIds = stage8CoreToolIds.filter(function (id) {
                    return STAGE8_OMIT_FOR_CEILING_PAINT.indexOf(id) === -1;
                });
            }
            (stage8ToolPackOnlyFromLivingFloors
                ? stage8CoreToolIds.filter(function (id) { return stage8OmitWhenOnlyLivingFloors.indexOf(id) === -1; })
                : stage8CoreToolIds).forEach(function (id) { add(8, id, 1); });
            if (hasPuttyWorkForCornerProfile) {
                [89445192, 89445233].forEach(function (id) { add(8, id, 1); });
            }
            add(8, 12893977, 3);
            if (!hasArmstrongCeilingSprav) {
                add(8, 87712166, 1);
                add(8, 82586216, 1);
            }
            if (hasPlasterWorkForCornerProfile || hasPuttyWorkForCornerProfile) {
                add(8, 16126433, 1);
            }
        }
        if (hasPaintBrushScope) {
            const BRUSH_50_SKU = '82798222';
            let brush50InStages = 0;
            for (let st = 2; st <= 10; st++) {
                const b50 = stage[st].get(BRUSH_50_SKU);
                if (b50) brush50InStages += b50;
            }
            if (brush50InStages === 0) add(8, 82798222, 1);
            const BRUSH_100_SKU = '82798224';
            let brush100InStages = 0;
            for (let st = 2; st <= 10; st++) {
                const b100 = stage[st].get(BRUSH_100_SKU);
                if (b100) brush100InStages += b100;
            }
            if (brush100InStages === 0) add(8, 82798224, 1);
        }

        /* Макловица 17567484: мин. 1 шт. при штукатурке / шпаклёвке / плитке, если артикула ещё нет в корзине */
        const MAKLOVITSA_SKU = '17567484';
        const hasPlasterStageForMak = Boolean(
            (selectedMaterials.additionalWalls && selectedMaterials.additionalWalls.some(m => m.type === 'plaster'))
            || (selectedMaterials.additionalWallTile && selectedMaterials.additionalWallTile.some(m => m.type === 'plaster'))
            || (selectedMaterials.ceilings && selectedMaterials.ceilings.some(c => c.type === 'plasterCeiling'))
            || (selectedMaterials.walls && selectedMaterials.walls.type === 'plaster')
        );
        const hasPuttyStageForMak = Boolean(
            hasWallPuttySprav
            || (selectedMaterials.ceilings && selectedMaterials.ceilings.some(c => c.type === 'puttyCeiling'))
        );
        const hasTileStageForMak = totalTileArea > 0;
        if (hasPlasterStageForMak || hasPuttyStageForMak || hasTileStageForMak) {
            let qMak = 0;
            for (let st = 2; st <= 10; st++) {
                const vm = stage[st].get(MAKLOVITSA_SKU);
                if (vm) qMak += vm;
            }
            if (qMak === 0) add(8, MAKLOVITSA_SKU, 1);
        }

        /* Обои: клей Kleo — 1 уп. на 50 м² стен; шпатель для прикатки — 1 шт. */
        if (hasWallpaperWallScope(selectedMaterials) && wallMaterialArea > 0) {
            add(8, 14382986, wallMaterialArea / 50);
            add(8, 15649398, 1);
        }

        /* Лезвия, подложка, клей — по каждому выбранному жилому покрытию (этап 8–9) */
        addLivingFloorCoveringBasketItems(add, selectedMaterials, laminateArea);

        const livingFloorMusorBags = computeLivingFloorFinishMusorBags(selectedMaterials, calc);
        if (livingFloorMusorBags > 0) {
            add(9, 17968499, livingFloorMusorBags / MUSOR_BAGS_PER_PACK);
        }

        /* Мешки для пылесоса 86262884: при выборе напольного покрытия жилых — 1 уп., если суммарно по этапам 2–10 ещё < 1 шт. (этап 2 с демонтажом может уже добавить). */
        const VACUUM_BAGS_SKU = '86262884';
        let vacuumBagsInStages = 0;
        for (let s = 2; s <= 10; s++) {
            const vb = stage[s].get(VACUUM_BAGS_SKU);
            if (vb) vacuumBagsInStages += vb;
        }
        if (hasLivingFloorCovering && vacuumBagsInStages < 1) {
            add(9, 86262884, 1);
        }

        // ЭТАП 10 — потолки и освещение (штукатурка/шпаклёвка потолка; Армстронг; освещение в корзину пока не включено)
        if (selectedMaterials.ceilings && selectedMaterials.ceilings.length > 0) {
            const ceilPrimerLayersForBasket = ceilingPrimerLayerCount(selectedMaterials.ceilings);
            if (ceilPrimerLayersForBasket > 0 && livingCeilingSqm > 0) {
                add(10, 12757510, livingCeilingSqm * ceilPrimerLayersForBasket * 0.015);
            }
            const hasPlasterCeiling = selectedMaterials.ceilings.some(c => c.type === 'plasterCeiling');
            if (hasPlasterCeiling) {
                const ceilingAreaVal = ceilingArea;
                add(10, 10073940, ceilingAreaVal * 12.75 / 30);
                const ceilingBeacons = perimeter / 1.2;
                add(10, 16126441, ceilingBeacons); add(10, 15534291, (ceilingBeacons * 6) / 25);
            }
            const hasPuttyCeiling = selectedMaterials.ceilings.some(function (c) { return c.type === 'puttyCeiling'; });
            if (hasPuttyCeiling && livingCeilingSqm > 0) {
                add(10, 89283063, livingCeilingSqm / 20);
                addPuttySandingSponges(add, 10, livingCeilingSqm);
            }
            const hasArmstrongCeiling = selectedMaterials.ceilings.some(function (c) { return c.type === 'armstrong'; });
            if (hasArmstrongCeiling) {
                let armstrongSqm = 0;
                selectedMaterials.ceilings.forEach(function (c) {
                    if (c.type !== 'armstrong' || !c.area) return;
                    const sq = parseAreaStringToSqm(c.area);
                    if (sq != null && sq > 0) armstrongSqm += sq;
                });
                if (armstrongSqm > 0) {
                    const ARMSTRONG_BOX_SQM = 7.2;
                    const ARMSTRONG_RESERVE = 1.1;
                    const armstrongPerimeterM = perimeter > 0 ? perimeter : (4 * Math.sqrt(armstrongSqm));
                    add(10, 82458369, (armstrongSqm * ARMSTRONG_RESERVE) / ARMSTRONG_BOX_SQM);
                    add(10, 15052647, armstrongSqm * 0.23);
                    add(10, 15052639, armstrongSqm * 1.4);
                    add(10, 15052621, armstrongSqm * 1.4);
                    add(10, 12903338, armstrongSqm * 0.7);
                    add(10, 13452305, armstrongPerimeterM / 3);
                    const armstrongAnchorPcs = Math.ceil(armstrongSqm * 0.7);
                    add(10, 89349442, Math.ceil(armstrongAnchorPcs / 100));
                    const armstrongMusorBags = Math.ceil(armstrongSqm / 10);
                    add(10, 17968499, Math.ceil(armstrongMusorBags / 10));
                    add(10, MUSHROOM_DOWEL_SKU, mushroomDowelPacksFromPerimeterM(armstrongPerimeterM));
                    if (partitionSkuQtyInStages('82909816') === 0) add(10, 82909816, 1);
                }
            }
        }

        /* Правила 88993423/88993426 при штукатурке потолка (plasterCeiling): этап 6, по 1 шт. каждого, только если оба артикула ещё не в корзине (стены/стяжка не добавили на этапе 6). */
        const hasPlasterCeilingForAluRules = selectedMaterials.ceilings && selectedMaterials.ceilings.some(function (c) { return c.type === 'plasterCeiling'; }) && ceilingArea > 0;
        if (hasPlasterCeilingForAluRules) {
            let aluRule1mInStages = 0;
            let aluRule2mInStages = 0;
            for (let s = 2; s <= 10; s++) {
                const q1 = stage[s].get('88993423');
                if (q1) aluRule1mInStages += q1;
                const q2 = stage[s].get('88993426');
                if (q2) aluRule2mInStages += q2;
            }
            if (aluRule1mInStages === 0 && aluRule2mInStages === 0) {
                add(6, 88993423, 1);
                add(6, 88993426, 1);
            }
        }

        /* Ротбанд 10073940: при электромонтаже, если по другим позициям штукатурка в корзину не попала — минимум 1 мешок (заделка штроб и т.п.); не при одной только проводке по потолку; не при одной только услуге «установка автоматов» (без штробления стен) */
        const ROTBAND_SKU = '10073940';
        let rotbandInStages = 0;
        for (let s = 2; s <= 10; s++) {
            const rq = stage[s].get(ROTBAND_SKU);
            if (rq) rotbandInStages += rq;
        }
        if (hasElectricalForMaterials && !electricalIsOnlyCeilingWiring && !electricalIsOnlyBreakers && rotbandInStages === 0) {
            add(6, 10073940, 1);
        }

        /* Грунтовка 12757510: при розетках / выключателях / терморегуляторе — мин. 1 банка 10 л, если СТ17 ещё не попал в корзину от этапов 6/10 и др. (проводка по потолку не требует отдельной мин. банки). */
        const CT17_SKU = '12757510';
        let ct17InStages = 0;
        for (let s = 2; s <= 10; s++) {
            const cq = stage[s].get(CT17_SKU);
            if (cq) ct17InStages += cq;
        }
        const elPrimerScope = totalOutlets > 0 || totalSwitches > 0 || totalThermostats > 0;
        if (elPrimerScope && ct17InStages === 0) {
            add(6, 12757510, 1);
        }

        /* Набор малярный Matrix 13653975: 1 шт. если в корзине есть грунтовка СТ17 (12757510); +1 шт. при обоях */
        let ct17QtyForMatrix = 0;
        for (let s = 2; s <= 10; s++) {
            const cqm = stage[s].get(CT17_SKU);
            if (cqm) ct17QtyForMatrix += cqm;
        }
        let matrixSetQty = 0;
        if (ct17QtyForMatrix > 0) matrixSetQty += 1;
        if (hasWallpaperWallScope(selectedMaterials) && wallMaterialArea > 0) matrixSetQty += 1;
        if (hasDecorativeWallScope(selectedMaterials) && computeRadugaDecorativeWallSqm(selectedMaterials) > 0) matrixSetQty += 1;
        if (matrixSetQty > 0) add(8, 13653975, matrixSetQty);

        /* Коронка 89404986: при розетках / выключателях — 1 шт., если артикул ещё не попал в корзину от других этапов */
        const CROWN_SKU = '89404986';
        let crownInStages = 0;
        for (let s = 2; s <= 10; s++) {
            const cr = stage[s].get(CROWN_SKU);
            if (cr) crownInStages += cr;
        }
        const elCrownScope = totalOutlets > 0 || totalSwitches > 0;
        if (elCrownScope && crownInStages === 0) {
            add(2, 89404986, 1);
        }

        /* Бур 89383376 SDS-plus 8×110 мм: при розетках / выключателях — 1 шт., если артикул ещё не попал в корзину от других этапов */
        const DRILL8_SKU = '89383376';
        let drill8InStages = 0;
        for (let s = 2; s <= 10; s++) {
            const d8 = stage[s].get(DRILL8_SKU);
            if (d8) drill8InStages += d8;
        }
        if (elCrownScope && drill8InStages === 0) {
            add(2, 89383376, 1);
        }

        /* Изолента IEK 12463053: при выборе электромонтажа — мин. 1 шт., если артикул ещё не попал в корзину от других этапов */
        const IEK_TAPE_SKU = '12463053';
        let iekTapeInStages = 0;
        for (let s = 2; s <= 10; s++) {
            const it = stage[s].get(IEK_TAPE_SKU);
            if (it) iekTapeInStages += it;
        }
        if (hasElectricalForMaterials && iekTapeInStages === 0) {
            add(3, 12463053, 1);
        }

        /* Ведро 89437391, шпатели 89445192 / 89445233, мешки 17968499 / 86262884, нож Matrix 12893977, перчатки 89407217: при розетках / выключателях / распредкоробках — по 1 уп. (шт.), если артикула ещё нет (демонтаж, этап 8, плинтус и т.д. могли уже добавить). */
        const EL_ROUGH_IN_SKUS = [
            { id: 89437391, stageNum: 3 },
            { id: 89445192, stageNum: 8 },
            { id: 89445233, stageNum: 8 },
            { id: 17968499, stageNum: 3 },
            { id: 86262884, stageNum: 3 },
            { id: 12893977, stageNum: 8 },
            { id: 89407217, stageNum: 3 }
        ];
        const elRoughInScope = (selectedMaterials.electrical || []).some(function (s) {
            return s.type === 'outlets' || s.type === 'switches' || s.type === 'junctionBoxes';
        });
        if (elRoughInScope) {
            EL_ROUGH_IN_SKUS.forEach(function (row) {
                const skuStr = String(row.id);
                let qSum = 0;
                for (let st = 2; st <= 10; st++) {
                    const q = stage[st].get(skuStr);
                    if (q) qSum += q;
                }
                if (qSum === 0) add(row.stageNum, row.id, 1);
            });
        }

        /* Дюбель-гвоздь 84038798 (уп. 500 шт.): ⌈P×2⌉ шт. → ⌈/500⌉ уп. (P — периметр зоны; для Армстронга — этап 10). Мин. 1 уп. при электромонтаже или коробе ГКЛ, если по формуле ещё 0. */
        const hasGypsumBoxSprav = (selectedMaterials.partitions || []).some(p => p.type === 'gypsumBox')
            || (selectedMaterials.additionalWallTile || []).some(m => m.type === 'box' && (parseInt(m.quantity, 10) || 0) > 0);
        const hasWallTileOrPorcelainOnWalls = Boolean(
            livingWallTileForBasket > 0
            || bathWallTileForGlue > 0
            || apronTileSqmForGlue > 0
        );
        const hasPgbPartitionSprav = pgbPartitionSqm > 0;
        const hasFoamPartitionSprav = foamPartitionSqm > 0;
        const hasBrickPartitionSprav = brickPartitionSqm > 0;
        const hasGypsumFramePartitionSprav = gypsumFrameScopeSqm > 0;
        const hasArmstrongCeilingForMushroom = selectedMaterials.ceilings && selectedMaterials.ceilings.some(function (c) { return c.type === 'armstrong'; });
        const mushroomDowelScope = hasElectricalForMaterials || hasGypsumBoxSprav || hasWallTileOrPorcelainOnWalls || hasPgbPartitionSprav || hasFoamPartitionSprav || hasBrickPartitionSprav || hasGypsumFramePartitionSprav || hasSkirtingSprav || hasArmstrongCeilingForMushroom;
        let mushroomPacksRequired = 0;
        const totalPartitionSqmForMushroom = pgbPartitionSqm + foamPartitionSqm + brickPartitionSqm + gypsumFramePartitionSqm;
        if (totalPartitionSqmForMushroom > 0) {
            mushroomPacksRequired += mushroomDowelPacksFromPerimeterM(partitionTrackPerimeterM(totalPartitionSqmForMushroom));
        }
        if (hasWallTileOrPorcelainOnWalls) {
            let wallTilePerimM = plasterWallPerimeter;
            if (!(wallTilePerimM > 0)) {
                const tileSq = livingWallTileForBasket + apronTileSqmForGlue + (selectedMaterials.wallTile ? wallTileArea : 0);
                if (tileSq > 0) wallTilePerimM = 4 * Math.sqrt(tileSq);
            }
            mushroomPacksRequired += mushroomDowelPacksFromPerimeterM(wallTilePerimM);
        }
        if (hasSkirtingSprav) {
            mushroomPacksRequired += mushroomDowelPacksFromPerimeterM(skirtingPerimeterMFromCalc(calc));
        }
        if (hasElectricalForMaterials || hasGypsumBoxSprav) {
            mushroomPacksRequired = Math.max(mushroomPacksRequired, 1);
        }
        const mushroomDowelInStages = mushroomDowelQtyInStages();
        const mushroomPacksToAdd = Math.max(0, mushroomPacksRequired - mushroomDowelInStages);
        if (mushroomDowelScope && mushroomPacksToAdd > 0) {
            add(6, MUSHROOM_DOWEL_SKU, mushroomPacksToAdd);
        }

        /* Плинтус (доп. пол): диск 88022833, перчатки 89407217; дюбель-гвоздь — по периметру ⌈P×2⌉/500 (см. блок выше). */
        if (hasSkirtingSprav) {
            const SKIRTING_DISC_SKU = '88022833';
            const SKIRTING_GLOVES_SKU = '89407217';
            let skirtingDiscQty = 0;
            let skirtingGlovesQty = 0;
            for (let sk = 2; sk <= 10; sk++) {
                const sd = stage[sk].get(SKIRTING_DISC_SKU);
                if (sd) skirtingDiscQty += sd;
                const sg = stage[sk].get(SKIRTING_GLOVES_SKU);
                if (sg) skirtingGlovesQty += sg;
            }
            if (skirtingDiscQty === 0) add(6, SKIRTING_DISC_SKU, 1);
            if (skirtingGlovesQty === 0) add(6, SKIRTING_GLOVES_SKU, 1);
        }

        /* Саморезы 89386326 / шурупы 89455924 (уп.): по 1 уп., если нет — короб ГКЛ (gypsumBox) или короб в санузле; перегородка на каркасе — 89386326 в блоке gypsumFrame + 87093939 на вес. */
        const GYPSUM_METAL_SCREW_SKU = '89386326';
        const GYPSUM_DRYWALL_SCREW_SKU = '89455924';
        let gypsumMetalScrewInStages = 0;
        let gypsumDrywallScrewInStages = 0;
        for (let gs = 2; gs <= 10; gs++) {
            const gm = stage[gs].get(GYPSUM_METAL_SCREW_SKU);
            if (gm) gypsumMetalScrewInStages += gm;
            const gd = stage[gs].get(GYPSUM_DRYWALL_SCREW_SKU);
            if (gd) gypsumDrywallScrewInStages += gd;
        }
        const needsGypsumBoxScrewPacks = (selectedMaterials.partitions || []).some(p => p.type === 'gypsumBox')
            || (selectedMaterials.additionalWallTile || []).some(m => m.type === 'box' && (parseInt(m.quantity, 10) || 0) > 0);
        if (needsGypsumBoxScrewPacks) {
            if (gypsumMetalScrewInStages === 0) add(6, GYPSUM_METAL_SCREW_SKU, 1);
            if (gypsumDrywallScrewInStages === 0) add(6, GYPSUM_DRYWALL_SCREW_SKU, 1);
        }

        /* Гладилка Vertextools 86220370, терки 15649363/15649371, диск 605125: при плитке/керамограните — мин. 1 шт. каждого, если артикула ещё нет в корзине (этапы 2–10) */
        const TILE_TOOLS_CERAMIC_SKUS = ['86220370', '15649363', '15649371', '605125'];
        if (nonMosaicSqm > 0) {
            TILE_TOOLS_CERAMIC_SKUS.forEach(function (sku) {
                let qTool = 0;
                for (let st = 2; st <= 10; st++) {
                    const qt = stage[st].get(sku);
                    if (qt) qTool += qt;
                }
                if (qTool === 0) add(7, sku, 1);
            });
        }
        /* Терка с губкой 15649363 — только мозаика (в площади нет керамики/керамогранита) */
        if (mosaicSqm > 0 && nonMosaicSqm === 0 && totalTileArea > 0) {
            let qSponge = 0;
            for (let st = 2; st <= 10; st++) {
                const qs = stage[st].get('15649363');
                if (qs) qSponge += qs;
            }
            if (qSponge === 0) add(7, 15649363, 1);
        }

        /* Малярная лента Dexter 82664800 48 мм × 50 м — плитка/мозаика: 1 шт., если артикула ещё нет в корзине; ламинат/ПВХ: площадь/50; покраска стен: (периметр×2)/50 (периметр ≈ 4×√ceilingArea или wallArea/высота) */
        const DEXTER_TAPE_48_SKU = '82664800';
        let dexterTape48InStages = 0;
        for (let s = 2; s <= 10; s++) {
            const dt = stage[s].get(DEXTER_TAPE_48_SKU);
            if (dt) dexterTape48InStages += dt;
        }
        if (totalTileArea > 0 && dexterTape48InStages === 0) {
            add(7, 82664800, 1);
        }
        getLivingFloorFinishVariants(selectedMaterials).forEach(function (f) {
            if (!f || !f.type) return;
            const sq = livingFloorVariantSqm(f, laminateArea);
            if (f.type === 'laminate' && sq > 0) add(7, 82664800, sq / 50);
            if (f.type === 'pvc' && sq > 0) add(7, 82664800, sq / 50);
        });
        if (selectedMaterials.walls && selectedMaterials.walls.type === 'paint') {
            const paintRoomPerimeterM = perimeter > 0 ? perimeter : (ceilingHeight > 0 && wallMaterialArea > 0 ? wallMaterialArea / ceilingHeight : 0);
            if (paintRoomPerimeterM > 0) {
                add(7, 82664800, (paintRoomPerimeterM * 2) / 50);
            }
        }

        /* Валик игольчатый 13323749, стержень телескопический 15369329: при наливном поле — по 1 шт., если артикула ещё нет в корзине (этапы 2–10) */
        const SELFLEVEL_NEEDLE_SKU = '13323749';
        const SELFLEVEL_POLE_SKU = '15369329';
        if (hasSelfLevelingFloors || hasSelfLevelingBathroom) {
            let qNeedle = 0;
            let qPole = 0;
            for (let st = 2; st <= 10; st++) {
                const n = stage[st].get(SELFLEVEL_NEEDLE_SKU);
                if (n) qNeedle += n;
                const p = stage[st].get(SELFLEVEL_POLE_SKU);
                if (p) qPole += p;
            }
            if (qNeedle === 0) add(6, 13323749, 1);
            if (qPole === 0) add(8, 15369329, 1);
        }

        /* Емкость Matrix 65 л (89468179): при наливном поле — 1 шт., если артикула ещё нет в корзине (этапы 2–10; штукатурка стен и т.п.) */
        const MIXING_BUCKET_SKU = '89468179';
        if (hasSelfLevelingFloors || hasSelfLevelingBathroom) {
            let qMixBucket = 0;
            for (let st = 2; st <= 10; st++) {
                const mb = stage[st].get(MIXING_BUCKET_SKU);
                if (mb) qMixBucket += mb;
            }
            if (qMixBucket === 0) add(6, MIXING_BUCKET_SKU, 1);
        }

        /* ПГП (пазогреб): плиты, Perlfix + общий набор перегородки (addPartitionPgpLikeAccessories). */
        if (pgbPartitionSqm > 0) {
            const pgpPlateAreaSqm = 0.667 * 0.5;
            add(7, 81932798, pgbPartitionSqm / pgpPlateAreaSqm);
            add(7, 10074214, (pgbPartitionSqm * 3.5) / 30);
            addPartitionPgpLikeAccessories(pgbPartitionSqm);
        }

        /* Пеноблок: блок и клей (этап 6), зубчатый шпатель + тот же набор, что у ПГП (этап 7 и расходники). */
        const porcelainTraySqm = selectedMaterials.bathroomPorcelainTraySqm || 0;
        if (porcelainTraySqm > 0) {
            const foamGlueKgPerSqmAt2mm = 2 * 1.3;
            const foamGlueBagKg = 25;
            add(6, 85945154, porcelainTraySqm / GAS_BLOCK_FACE_SQM);
            add(6, 15163435, (porcelainTraySqm * foamGlueKgPerSqmAt2mm) / foamGlueBagKg);
            add(6, 12757510, porcelainTraySqm * 0.015);
            if (partitionSkuQtyInStages('86220370') === 0) add(7, 86220370, 1);
            PORCELAIN_TRAY_IF_ABSENT_TOOLS.forEach(function (row) {
                if (partitionSkuQtyInStages(row.sku) === 0) add(row.stage, row.sku, 1);
            });
        }

        if (foamPartitionSqm > 0) {
            const foamGlueKgPerSqmAt2mm = 2 * 1.3;
            const foamGlueBagKg = 25;
            add(6, 85945153, foamPartitionSqm / GAS_BLOCK_FACE_SQM);
            add(6, 15163435, (foamPartitionSqm * foamGlueKgPerSqmAt2mm) / foamGlueBagKg);
            if (partitionSkuQtyInStages('89445199') === 0) add(6, 89445199, 1);
            addPartitionPgpLikeAccessories(foamPartitionSqm);
        }

        /* Кирпич 250×120×65: 86672974 — 52 шт/м² (паспорт ЛМ); пескобетон M300 15163427 — ⌈м²×38 кг/м²/30 кг⌉; кельма 82338286 — 1 шт., если нет; общий набор перегородки. */
        if (brickPartitionSqm > 0) {
            const brickPerSqm = 52;
            const brickMortarKgPerSqm = 38;
            const brickMortarBagKg = 30;
            add(6, 86672974, brickPartitionSqm * brickPerSqm);
            add(6, 15163427, (brickPartitionSqm * brickMortarKgPerSqm) / brickMortarBagKg);
            if (partitionSkuQtyInStages('82338286') === 0) add(6, 82338286, 1);
            addPartitionPgpLikeAccessories(brickPartitionSqm);
        }

        /* ГКЛ на каркасе: перегородка — 2 слоя ГКЛ, ПС 12756948; жилые стены walls-gypsum — 1 слой, ПП 18734926. */
        const GKL_SHEET_SQM = 2.5 * 1.2;
        const GKL_SCREW_PCS_PER_SHEET = 70;
        const GKL_SCREW_KG_PER_1000 = (1.1 + 1.78) / 2;
        const GKL_SERPYANKA_SKU = '81971720';
        const GKL_SERPYANKA_ROLL_LEN_M = 20;
        const GKL_SERPYANKA_M_PER_GKL_SQM = 1.2;
        /** S — площадь одной стороны, м²; sides — 2 для перегородки (обе стороны), 1 для стен. */
        function gklSheetCountForFaceSqm(faceSqm, sides) {
            if (!(faceSqm > 0) || !(sides > 0)) return 0;
            return sides * Math.ceil(faceSqm / GKL_SHEET_SQM);
        }
        function gklScrewKgFromSheetCount(sheetCount) {
            if (!(sheetCount > 0)) return 0;
            return (sheetCount * GKL_SCREW_PCS_PER_SHEET / 1000) * GKL_SCREW_KG_PER_1000;
        }
        if (gypsumFrameScopeSqm > 0) {
            const gfSqm = gypsumFrameScopeSqm;
            const gfH = ceilingHeight > 0 ? ceilingHeight : 2.7;
            const gfRunM = gfSqm / gfH;
            const insulPackSqm = 6.1;
            let gklSheetCountTotal = 0;
            if (gypsumFramePartitionSqm > 0) {
                gklSheetCountTotal += gklSheetCountForFaceSqm(gypsumFramePartitionSqm, 2);
            }
            if (gypsumFrameLivingWallSqm > 0) {
                gklSheetCountTotal += gklSheetCountForFaceSqm(gypsumFrameLivingWallSqm, 1);
            }
            if (gklSheetCountTotal > 0) add(7, 10072745, gklSheetCountTotal);
            add(7, 12756921, (2 * gfRunM) / 3);
            if (gypsumFramePartitionSqm > 0) {
                const runPartM = gypsumFramePartitionSqm / gfH;
                add(7, 12756948, runPartM / 0.6 + 1);
            }
            if (gypsumFrameLivingWallSqm > 0) {
                const runWallM = gypsumFrameLivingWallSqm / gfH;
                add(7, GYPSUM_BOX_PP_1500_SKU, runWallM / 0.6 + 1);
            }
            if (gypsumFramePartitionSqm > 0) {
                add(7, 82097207, gypsumFramePartitionSqm / insulPackSqm);
            }
            let gklScrewKg = 0;
            if (gypsumFramePartitionSqm > 0) {
                gklScrewKg += gklScrewKgFromSheetCount(gklSheetCountForFaceSqm(gypsumFramePartitionSqm, 2));
            }
            if (gypsumFrameLivingWallSqm > 0) {
                gklScrewKg += gklScrewKgFromSheetCount(gklSheetCountForFaceSqm(gypsumFrameLivingWallSqm, 1));
            }
            if (gklScrewKg > 0) add(7, 87093939, gklScrewKg);
            const gklInstalledSqm = 2 * gypsumFramePartitionSqm + gypsumFrameLivingWallSqm;
            if (gklInstalledSqm > 0) {
                add(7, GKL_SERPYANKA_SKU, (gklInstalledSqm * GKL_SERPYANKA_M_PER_GKL_SQM) / GKL_SERPYANKA_ROLL_LEN_M);
            }
            if (partitionSkuQtyInStages('89386326') === 0) add(7, 89386326, 1);
            addPartitionPgpLikeAccessories(gfSqm, { skipPgpSuspensionKit: true });
        }

        /* Инструмент для ГКЛ (рубанок 86550311, пила 15241309): перегородка на каркасе или короб — по 1 шт., если артикула ещё нет (этапы 2–10). */
        const hasGypsumPartitionOrBox = gypsumFrameScopeSqm > 0
            || (selectedMaterials.partitions || []).some(function (p) { return p.type === 'gypsumBox'; })
            || (selectedMaterials.additionalWallTile || []).some(function (m) {
                return m.type === 'box' && (parseInt(m.quantity, 10) || 0) > 0;
            });
        if (hasGypsumPartitionOrBox) {
            ['86550311', '15241309'].forEach(function (sku) {
                if (partitionSkuQtyInStages(sku) === 0) add(7, sku, 1);
            });
        }

        /* Черенок 17496815 и щётка «Люкс» 17517621: при демонтаже — по 1 шт., если артикула ещё нет в корзине по этапам 2–10 (этап 6/8 могли уже добавить). */
        if (hasDemolition) {
            ['17496815', '17517621'].forEach(function (sku) {
                let qSum = 0;
                for (let st = 2; st <= 10; st++) {
                    const q = stage[st].get(sku);
                    if (q) qSum += q;
                }
                if (qSum === 0) add(2, sku, 1);
            });
        }

        // Итог: merged — сумма по всем этапам; порядок в URL — по этапам 2→10 (первое появление id)
        const merged = new Map();
        for (let s = 2; s <= 10; s++) {
            stage[s].forEach((qty, id) => {
                const key = String(id);
                merged.set(key, (merged.get(key) || 0) + qty);
            });
        }
        return { stage, merged };
    }

function getBasketUrl(lastCalc, ch) {
    return getBasketUrlForStageRange(lastCalc, ch, 2, 10);
}

function getBasketUrlForStageRange(lastCalc, ch, minStage, maxStage) {
    const { stage, merged } = getBasketProducts(lastCalc, ch);
    const parts = [];
    const seen = new Set();
    const minS = Math.max(2, minStage || 2);
    const maxS = Math.min(10, maxStage || 10);
    const LEMANA_BASKET_BASE = 'https://novosibirsk.lemanapro.ru/basket/?products=';
    const LEMANA_SHARE = '&share_cart=1';
    for (let s = minS; s <= maxS; s++) {
        if (!stage[s]) continue;
        stage[s].forEach(function (qty, id) {
            const sid = String(id);
            if (!seen.has(sid)) {
                const q = merged.get(sid) || 0;
                parts.push(lemanaBasketProductParamFromSku(sid) + ':' + Math.max(1, Math.ceil(q)));
                seen.add(sid);
            }
        });
    }
    if (parts.length === 0) return '';
    return LEMANA_BASKET_BASE + parts.join(',') + LEMANA_SHARE;
}

/** HTML-панель корзины по диапазону этапов (2–7 черновые, 8–10 финишные). */
function buildBasketStageRangePanelHtml(lastCalc, ch, minStage, maxStage) {
    const { stage, merged } = getBasketProducts(lastCalc, ch);
    const entries = [];
    const seen = new Set();
    const minS = Math.max(2, minStage || 2);
    const maxS = Math.min(10, maxStage || 10);
    for (let s = minS; s <= maxS; s++) {
        if (!stage[s]) continue;
        stage[s].forEach(function (qty, id) {
            const sku = String(id);
            if (seen.has(sku)) return;
            seen.add(sku);
            const q = Math.max(1, Math.ceil(parseFloat(String(merged.get(sku))) || 0));
            entries.push([sku, q]);
        });
    }
    entries.sort(function (a, b) { return parseInt(a[0], 10) - parseInt(b[0], 10); });
    if (!entries.length) {
        return '<p class="est-panel-empty">Нет позиций для выбранных работ.</p>';
    }
    let rows = '';
    entries.forEach(function (e) {
        rows += '<tr><td class="sku">' + escapeHtmlText(e[0]) + '</td><td class="est-basket-qty">' + escapeHtmlText(String(e[1])) + '</td></tr>';
    });
    let html = '<table class="est-basket-table"><thead><tr><th>Артикул</th><th>Кол-во</th></tr></thead><tbody>' + rows + '</tbody></table>';
    const url = getBasketUrlForStageRange(lastCalc, ch, minStage, maxStage);
    if (url) {
        html += '<p class="est-panel-basket-link"><a href="' + escapeHtmlText(url) + '" target="_blank" rel="noopener noreferrer">Корзина Леруа Мерлен</a></p>';
    }
    return html;
}

function formatScheduleDateInputToday() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
}

/** Лента «График работ» для мобильной панели. startDateInput: YYYY-MM-DD; по умолчанию — сегодня; false — без календарных дат. */
function buildScheduleTimelinePanelHtml(calc, startDateInput) {
    let scheduleData = buildScheduleData(calc);
    if (!scheduleData.stages || !scheduleData.stages.length) {
        return '<p class="est-panel-empty">Нет этапов для выбранных работ.</p>';
    }
    const startIso = startDateInput === false ? '' : (startDateInput || formatScheduleDateInputToday());
    if (startIso) {
        scheduleData = applyScheduleStartDate(scheduleData, startIso);
    }
    let summary = scheduleData.totalHours + ' ч · ' + scheduleData.totalDays + ' календ. дн. (1 раб. день = ' + scheduleData.hDay + ' ч)';
    if (scheduleData.scheduleDateStart && scheduleData.scheduleDateEnd) {
        summary += ' · ' + scheduleData.scheduleDateStart + ' — ' + scheduleData.scheduleDateEnd;
    }
    let html = '<div class="sprav-schedule-wrap">';
    html += '<p class="est-schedule-summary">' + escapeHtmlText(summary) + '</p>';
    html += buildScheduleTimelineHtml(scheduleData);
    html += '</div>';
    return html;
}

    function parseEstimateInputNumber(v) {
        if (v == null || String(v).trim() === '') return NaN;
        const n = parseFloat(String(v).replace(/\s+/g, '').replace(',', '.'));
        return typeof n === 'number' && !isNaN(n) ? n : NaN;
    }

    /** Текст из ячейки сметы (contenteditable или legacy input). */
    function estimateCellRawText(el) {
        if (!el) return '';
        if (el.value !== undefined && el.tagName === 'INPUT') return String(el.value);
        const t = el.innerText != null ? el.innerText : el.textContent;
        return String(t || '').replace(/\u00a0/g, ' ');
    }

    /** Число для Excel HTML: x:num задаёт значение явно (без «число как текст» и без даты из «5.7»). */
    function estimateExcelNumberCellHtml(n, decimalPlaces) {
        if (n == null || !isFinite(Number(n))) {
            return '<td class="number" style="text-align:right"></td>';
        }
        const x = Number(n);
        const dp = decimalPlaces == null ? null : Math.max(0, Math.min(4, Number(decimalPlaces) || 0));
        const isInt = Math.abs(x - Math.round(x)) < 1e-9;
        if (isInt) {
            const v = Math.round(x);
            return `<td class="number" x:num="${v}" style="mso-number-format:'0';text-align:right">${v}</td>`;
        }
        const places = dp != null ? dp : 1;
        const numStr = x.toFixed(places);
        const display = numStr.replace('.', ',');
        return `<td class="number" x:num="${numStr}" style="mso-number-format:'0.${'0'.repeat(places)}';text-align:right">${escapeHtmlText(display)}</td>`;
    }

    /** Расценка и стоимость — целые. */
    function estimateExcelNumericCellHtml(n) {
        return estimateExcelNumberCellHtml(n, 0);
    }

    /** Объём: дробные м²/п.м. — число с одним знаком (x:num + 0.0), не текст @. */
    function estimateExcelQtyCellHtml(n) {
        return estimateExcelNumberCellHtml(n, 1);
    }

    /** Строка-заголовок раздела в Excel: inline-стили — Excel не всегда читает CSS-классы (особенно «category plumbing»). */
    function estimateExcelCategoryRowHtml(sectionName) {
        const tdStyle = 'background-color:#D9E2F3;color:#2F5597;font-weight:bold;padding:8px;border:1px solid #ddd;';
        return `<tr class="category"><td colspan="5" style="${tdStyle}">${escapeHtmlText(sectionName)}</td></tr>`;
    }

    function estimateExcelSubcategoryRowHtml(subsectionName) {
        const tdStyle = 'background-color:#E7F0FD;color:#2F5597;font-weight:bold;padding:8px;border:1px solid #ddd;';
        return `<tr class="subcategory"><td colspan="5" style="${tdStyle}">${escapeHtmlText(subsectionName)}</td></tr>`;
    }

    function estimateRowRecalcCostFromRateQty(row) {
        const rateEl = row.querySelector('.est-cell-rate');
        const qtyEl = row.querySelector('.est-cell-qty');
        const costEl = row.querySelector('.est-cell-cost');
        if (!rateEl || !qtyEl || !costEl) return;
        const r = parseEstimateInputNumber(estimateCellRawText(rateEl));
        const q = parseEstimateInputNumber(estimateCellRawText(qtyEl));
        if (isNaN(r) || isNaN(q)) return;
        costEl.textContent = String(Math.round(r * q));
    }

    const ESTIMATE_RATE_PCT_MIN = -50;
    const ESTIMATE_RATE_PCT_MAX = 50;

    function getEstimateAdjustHost() {
        return document.getElementById('spravEstimateNative');
    }

    function clampEstimateRatePercent(pct) {
        let n = Math.round(Number(pct) || 0);
        if (n < ESTIMATE_RATE_PCT_MIN) n = ESTIMATE_RATE_PCT_MIN;
        if (n > ESTIMATE_RATE_PCT_MAX) n = ESTIMATE_RATE_PCT_MAX;
        return n;
    }

    function getEstimateRatePercent() {
        const host = getEstimateAdjustHost();
        if (!host) return 0;
        const legacyRub = host.getAttribute('data-estimate-adjust-rub');
        if (legacyRub != null && legacyRub !== '' && !host.hasAttribute('data-estimate-rate-pct')) {
            host.removeAttribute('data-estimate-adjust-rub');
        }
        return clampEstimateRatePercent(host.getAttribute('data-estimate-rate-pct') || '0');
    }

    function setEstimateRatePercent(val) {
        const host = getEstimateAdjustHost();
        if (!host) return 0;
        const n = clampEstimateRatePercent(val);
        host.setAttribute('data-estimate-rate-pct', String(n));
        return n;
    }

    function adjustedRateFromBase(base, pct) {
        const b = parseFloat(base);
        if (isNaN(b) || b <= 0) return 0;
        return Math.max(0, Math.round(b * (1 + (pct || 0) / 100)));
    }

    function captureEstimateBaseRates(tableEl) {
        if (!tableEl) return;
        tableEl.querySelectorAll('tbody tr.work-item .est-cell-rate').forEach(function (cell) {
            if (cell.getAttribute('data-base-rate') != null && cell.getAttribute('data-base-rate') !== '') return;
            const r = parseEstimateInputNumber(estimateCellRawText(cell));
            if (!isNaN(r)) cell.setAttribute('data-base-rate', String(Math.round(r)));
        });
    }

    function syncBaseRateFromDisplayedRate(rateEl, pct) {
        if (!rateEl) return;
        const displayed = parseEstimateInputNumber(estimateCellRawText(rateEl));
        if (isNaN(displayed)) return;
        const mult = 1 + (pct || 0) / 100;
        const base = mult !== 0 ? Math.round(displayed / mult) : Math.round(displayed);
        rateEl.setAttribute('data-base-rate', String(Math.max(0, base)));
    }

    function applyEstimateRatePercentToTable(tableEl, pct) {
        if (!tableEl) return;
        captureEstimateBaseRates(tableEl);
        const p = clampEstimateRatePercent(pct);
        tableEl.querySelectorAll('tbody tr.work-item').forEach(function (row) {
            const rateEl = row.querySelector('.est-cell-rate');
            if (!rateEl) return;
            let base = parseFloat(rateEl.getAttribute('data-base-rate'));
            if (isNaN(base)) {
                base = parseEstimateInputNumber(estimateCellRawText(rateEl));
                if (isNaN(base)) base = 0;
                rateEl.setAttribute('data-base-rate', String(Math.round(base)));
            }
            rateEl.textContent = String(adjustedRateFromBase(base, p));
            estimateRowRecalcCostFromRateQty(row);
        });
    }

    function getEstimateSumFromTable(tableEl) {
        if (!tableEl) return 0;
        let sum = 0;
        tableEl.querySelectorAll('tbody tr.work-item .est-cell-cost').forEach(function (cell) {
            const n = parseEstimateInputNumber(estimateCellRawText(cell));
            if (!isNaN(n)) sum += Math.round(n);
        });
        return sum;
    }

    function refreshEstimateAdjustBarUi(finalSum, pct) {
        const bar = document.getElementById('spravEstimateAdjustBar');
        if (!bar) return;
        const valEl = bar.querySelector('.estimate-adjust-value');
        const finalEl = bar.querySelector('.estimate-adjust-final');
        const slider = bar.querySelector('.estimate-adjust-slider');
        if (valEl) {
            const sign = pct > 0 ? '+' : '';
            valEl.textContent = pct === 0 ? '0%' : sign + pct + '%';
            valEl.classList.toggle('is-negative', pct < 0);
            valEl.classList.toggle('is-positive', pct > 0);
        }
        if (finalEl) finalEl.textContent = finalSum.toLocaleString('ru-RU') + ' ₽';
        if (slider && slider !== document.activeElement) slider.value = String(pct);
    }

    function refreshEstimateTotalsForTable(tableEl) {
        if (!tableEl) return;
        const sum = getEstimateSumFromTable(tableEl);
        const pct = getEstimateRatePercent();
        const foot = tableEl.querySelector('tfoot .estimate-total-sum');
        if (foot) foot.textContent = sum.toLocaleString('ru-RU') + ' ₽';
        refreshEstimateAdjustBarUi(sum, pct);
    }

    function refreshEstimateWithRatePercent(tableEl) {
        if (!tableEl) return;
        applyEstimateRatePercentToTable(tableEl, getEstimateRatePercent());
        refreshEstimateTotalsForTable(tableEl);
    }

    function ensureEstimateAdjustmentControls(hostEl) {
        if (!hostEl || hostEl.dataset.cmetEstimateAdjustBound === '1') return;
        hostEl.dataset.cmetEstimateAdjustBound = '1';
        hostEl.addEventListener('click', function (ev) {
            const minus = ev.target && ev.target.closest ? ev.target.closest('.estimate-adjust-minus') : null;
            const plus = ev.target && ev.target.closest ? ev.target.closest('.estimate-adjust-plus') : null;
            if (!minus && !plus) return;
            ev.preventDefault();
            const table = hostEl.querySelector('table.estimate-table');
            let pct = getEstimateRatePercent() + (minus ? -1 : 1);
            setEstimateRatePercent(pct);
            if (table) refreshEstimateWithRatePercent(table);
        });
        hostEl.addEventListener('input', function (ev) {
            const slider = ev.target && ev.target.classList && ev.target.classList.contains('estimate-adjust-slider')
                ? ev.target : null;
            if (!slider || !hostEl.contains(slider)) return;
            setEstimateRatePercent(parseInt(slider.value, 10) || 0);
            const table = hostEl.querySelector('table.estimate-table');
            if (table) refreshEstimateWithRatePercent(table);
        });
    }

    function estimateTableDelegationHandler(ev) {
        const raw = ev.target;
        const t = raw && raw.nodeType === 3 ? raw.parentElement : raw;
        if (!t || !t.closest) return;
        const row = t.closest('tr.work-item');
        if (!row || !ev.currentTarget.contains(row)) return;
        const table = row.closest('table.estimate-table');
        if (!table) return;
        const td = t.closest && t.closest('td.est-cell-rate, td.est-cell-qty, td.est-cell-unit, td.est-cell-cost');
        if (td && td.classList.contains('est-cell-rate')) {
            syncBaseRateFromDisplayedRate(td, getEstimateRatePercent());
        }
        if (td && (td.classList.contains('est-cell-rate') || td.classList.contains('est-cell-qty'))) {
            estimateRowRecalcCostFromRateQty(row);
        }
        refreshEstimateTotalsForTable(table);
    }

    function estimateTablePasteHandler(ev) {
        const raw = ev.target;
        const el = raw && raw.nodeType === 3 ? raw.parentElement : raw;
        const td = el && el.closest ? el.closest('td.est-cell[contenteditable="true"]') : null;
        if (!td || !ev.currentTarget.contains(td)) return;
        ev.preventDefault();
        const text = (ev.clipboardData || window.clipboardData).getData('text/plain').replace(/\r?\n/g, ' ').trim();
        let ok = false;
        try {
            ok = document.execCommand('insertText', false, text);
        } catch (eCmd) { ok = false; }
        if (!ok) td.textContent = text;
        const row = td.closest('tr.work-item');
        const table = td.closest('table.estimate-table');
        if (td.classList.contains('est-cell-rate')) {
            syncBaseRateFromDisplayedRate(td, getEstimateRatePercent());
        }
        if (row && (td.classList.contains('est-cell-rate') || td.classList.contains('est-cell-qty'))) {
            estimateRowRecalcCostFromRateQty(row);
        }
        if (table) refreshEstimateTotalsForTable(table);
    }

    function estimateTableKeydownHandler(ev) {
        if (ev.key !== 'Enter') return;
        const raw = ev.target;
        const el = raw && raw.nodeType === 3 ? raw.parentElement : raw;
        const td = el && el.closest ? el.closest('td.est-cell[contenteditable="true"]') : null;
        if (!td || !ev.currentTarget.contains(td)) return;
        ev.preventDefault();
        td.blur();
    }

    function estimateTableFocusOutHandler(ev) {
        const td = ev.target && ev.target.closest ? ev.target.closest('td.est-cell') : null;
        if (!td || !ev.currentTarget.contains(td)) return;
        const table = td.closest('table.estimate-table');
        if (td.classList.contains('est-cell-rate')) {
            syncBaseRateFromDisplayedRate(td, getEstimateRatePercent());
        }
        if (table) refreshEstimateTotalsForTable(table);
    }

    /** Один слушатель на контейнер (напр. spravEstimateNative): правка полей перед экспортом. */
    function ensureEstimateTableLiveEditors(hostEl) {
        if (!hostEl || hostEl.dataset.cmetEstimateEditorsBound === '1') return;
        hostEl.dataset.cmetEstimateEditorsBound = '1';
        hostEl.addEventListener('input', estimateTableDelegationHandler);
        hostEl.addEventListener('change', estimateTableDelegationHandler);
        hostEl.addEventListener('paste', estimateTablePasteHandler);
        hostEl.addEventListener('keydown', estimateTableKeydownHandler);
        hostEl.addEventListener('focusout', estimateTableFocusOutHandler);
        hostEl.addEventListener('click', estimateTableClickHandler);
    }

    function parseWorkItemRow(tr) {
        const nameEl = tr.querySelector('.est-cell-name');
        const rateEl = tr.querySelector('.est-cell-rate');
        const qtyEl = tr.querySelector('.est-cell-qty');
        const unitEl = tr.querySelector('.est-cell-unit');
        const costEl = tr.querySelector('.est-cell-cost');
        const r = parseEstimateInputNumber(estimateCellRawText(rateEl));
        const q = parseEstimateInputNumber(estimateCellRawText(qtyEl));
        const c = parseEstimateInputNumber(estimateCellRawText(costEl));
        const item = {
            name: String(estimateCellRawText(nameEl) || '').trim(),
            rate: isNaN(r) ? 0 : r,
            quantity: isNaN(q) ? 0 : q,
            unit: String(estimateCellRawText(unitEl) || '').trim()
        };
        if (!isNaN(c)) item.cost = Math.round(c);
        return item;
    }

    /** Строит дерево разделов из текущей таблицы (редактирование, добавленные/удалённые строки). */
    function parseEstimateTableBodyToSections(tbody) {
        const sections = [];
        let curSection = null;
        let curSub = null;
        tbody.querySelectorAll(':scope > tr').forEach((tr) => {
            if (tr.classList.contains('category')) {
                const td = tr.cells[0];
                let name = '';
                if (td) {
                    const strong = td.querySelector('strong');
                    name = String(estimateCellRawText(strong || td) || '').trim();
                }
                curSection = { name: name, subsections: [] };
                sections.push(curSection);
                curSub = null;
                return;
            }
            if (tr.classList.contains('subcategory')) {
                if (!curSection) {
                    curSection = { name: '', subsections: [] };
                    sections.push(curSection);
                }
                const td = tr.cells[0];
                let name = '';
                if (td) {
                    const em = td.querySelector('em');
                    name = String(estimateCellRawText(em || td) || '').trim();
                }
                curSub = { name: name, items: [] };
                curSection.subsections.push(curSub);
                return;
            }
            if (tr.classList.contains('work-item')) {
                if (!curSection) {
                    curSection = { name: '', subsections: [] };
                    sections.push(curSection);
                }
                if (!curSub) {
                    curSub = { name: '', items: [] };
                    curSection.subsections.push(curSub);
                }
                curSub.items.push(parseWorkItemRow(tr));
            }
        });
        return sections;
    }

    /**
     * Собирает смету с учётом таблицы в DOM: наименования, числа, добавленные и удалённые строки.
     * @param {HTMLElement} mirrorRoot узел с таблицей (напр. spravEstimateMirror).
     */
    function collectEstimateFromMirror(mirrorRoot, baseEd) {
        if (!baseEd || !mirrorRoot || !mirrorRoot.querySelector) return baseEd;
        const tbody = mirrorRoot.querySelector('table.estimate-table tbody');
        if (!tbody) return baseEd;
        let clone;
        try {
            clone = JSON.parse(JSON.stringify(baseEd));
        } catch (e) {
            return baseEd;
        }
        const parsed = parseEstimateTableBodyToSections(tbody);
        if (parsed && parsed.length) clone.sections = parsed;
        clone.ratePercent = getEstimateRatePercent();
        return clone;
    }

    function applyEstimateDomEdits(mirrorRoot, baseEd) {
        return collectEstimateFromMirror(mirrorRoot, baseEd);
    }

    function estimateNewRowSuffix() {
        return 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    }

    function buildEstimateWorkRowHtml(idSuf, item) {
        const rateRaw = parseFloat(item.rate);
        const quantityRaw = parseFloat(item.quantity);
        const rate = isNaN(rateRaw) ? 0 : rateRaw;
        const quantity = isNaN(quantityRaw) ? 0 : quantityRaw;
        let cost;
        if (item.cost !== undefined && item.cost !== null && !isNaN(Number(item.cost))) {
            cost = Math.round(Number(item.cost));
        } else {
            cost = Math.round(rate * quantity);
        }
        const qtyStr = (quantity % 1 === 0 ? String(Math.round(quantity)) : String(quantity)).replace('.', ',');
        const baseRate = Math.round(rate);
        const rateStrVal = Number.isFinite(rate) ? String(baseRate) : '';
        return `
                        <tr class="work-item">
                            <td class="est-actions"><button type="button" class="est-row-add" title="Добавить строку ниже" aria-label="Добавить строку ниже">+</button><button type="button" class="est-row-del" title="Удалить строку" aria-label="Удалить строку">×</button></td>
                            <td class="est-cell est-cell-name" contenteditable="true" spellcheck="false" tabindex="0" id="est-name-${idSuf}" role="textbox" aria-label="Наименование работ" title="Наименование работ">${escapeHtmlText(item.name || '')}</td>
                            <td class="number est-cell est-cell-rate" contenteditable="true" spellcheck="false" tabindex="0" id="est-rate-${idSuf}" role="textbox" aria-label="Расценка, руб" title="Расценка, руб" data-base-rate="${baseRate}">${escapeHtmlText(rateStrVal)}</td>
                            <td class="number est-cell est-cell-qty" contenteditable="true" spellcheck="false" tabindex="0" id="est-qty-${idSuf}" role="textbox" aria-label="Объем" title="Объем">${escapeHtmlText(qtyStr)}</td>
                            <td class="center est-cell est-cell-unit" contenteditable="true" spellcheck="false" tabindex="0" id="est-unit-${idSuf}" role="textbox" aria-label="Единица измерения" title="Единица измерения">${escapeHtmlText(item.unit || '')}</td>
                            <td class="number est-cell est-cell-cost" contenteditable="true" spellcheck="false" tabindex="0" id="est-cost-${idSuf}" role="textbox" aria-label="Стоимость, руб" title="Стоимость, руб">${cost}</td>
                        </tr>
                    `;
    }

    /** Удаляет заголовок подраздела без строк работ и пустой раздел целиком. */
    function cleanupEmptyEstimateSubsectionsAndSections(tbody) {
        if (!tbody) return;
        let guard = 0;
        while (guard < 24) {
            guard++;
            const rows = Array.from(tbody.querySelectorAll(':scope > tr'));
            let removed = false;
            for (let i = 0; i < rows.length; i++) {
                const tr = rows[i];
                if (!tr.classList.contains('subcategory')) continue;
                let w = 0;
                for (let j = i + 1; j < rows.length; j++) {
                    const r = rows[j];
                    if (r.classList.contains('category') || r.classList.contains('subcategory')) break;
                    if (r.classList.contains('work-item')) w++;
                }
                if (w === 0) {
                    tr.remove();
                    removed = true;
                    break;
                }
            }
            if (removed) continue;
            for (let i = 0; i < rows.length; i++) {
                const tr = rows[i];
                if (!tr.classList.contains('category')) continue;
                let w = 0;
                for (let j = i + 1; j < rows.length; j++) {
                    const r = rows[j];
                    if (r.classList.contains('category')) break;
                    if (r.classList.contains('work-item')) w++;
                }
                if (w === 0) {
                    let n = tr.nextElementSibling;
                    while (n && !n.classList.contains('category')) {
                        const x = n;
                        n = n.nextElementSibling;
                        x.remove();
                    }
                    tr.remove();
                    removed = true;
                    break;
                }
            }
            if (!removed) break;
        }
    }

    function estimateTableClickHandler(ev) {
        const addBtn = ev.target && ev.target.closest ? ev.target.closest('button.est-row-add') : null;
        const delBtn = ev.target && ev.target.closest ? ev.target.closest('button.est-row-del') : null;
        if (addBtn && ev.currentTarget.contains(addBtn)) {
            ev.preventDefault();
            const row = addBtn.closest('tr.work-item');
            if (!row || !ev.currentTarget.contains(row)) return;
            row.insertAdjacentHTML('afterend', buildEstimateWorkRowHtml(estimateNewRowSuffix(), {
                name: '',
                rate: 0,
                quantity: 1,
                unit: 'шт.',
                cost: 0
            }));
            estimateRowRecalcCostFromRateQty(row.nextElementSibling);
            const table = row.closest('table.estimate-table');
            if (table) refreshEstimateTotalsForTable(table);
            return;
        }
        if (delBtn && ev.currentTarget.contains(delBtn)) {
            ev.preventDefault();
            const row = delBtn.closest('tr.work-item');
            if (!row || !ev.currentTarget.contains(row)) return;
            const table = row.closest('table.estimate-table');
            row.remove();
            if (table) {
                const tbody = table.querySelector('tbody');
                if (tbody) cleanupEmptyEstimateSubsectionsAndSections(tbody);
                refreshEstimateTotalsForTable(table);
            }
        }
    }

    const ESTIMATE_ADDITIONAL_SECTION_NAME = 'ДОПОЛНИТЕЛЬНЫЕ И ПРОЧИЕ РАБОТЫ';

    function buildEstimateGiftNoteRowHtml() {
        return '<tr class="estimate-gift-note">' +
            '<td colspan="6">' +
            '<div class="estimate-gift-note__box">' +
            '<span class="estimate-gift-note__badge">В подарок</span>' +
            '<div class="estimate-gift-note__body">' +
            '<p class="estimate-gift-note__lead">При заказе <strong>комплекса работ</strong></p>' +
            '<ul class="estimate-gift-note__perks" aria-label="Бесплатно при комплексе работ">' +
            '<li>Выезд на замер</li>' +
            '<li>Составление сметы</li>' +
            '<li>Технический проект</li>' +
            '</ul>' +
            '<p class="estimate-gift-note__accent">Бесплатно</p>' +
            '</div></div></td></tr>';
    }

    function buildEstimateGiftNoteExcelRowHtml() {
        return '<tr class="subcategory"><td colspan="5" style="background:#f0f7ff;color:#2f5597;font-style:normal;padding:10px 8px;line-height:1.45;">' +
            'При заказе комплекса работ бесплатно: выезд на замер, составление сметы, технический проект' +
            '</td></tr>';
    }

    function buildEstimateTableHtml(estimateData) {
        const docTitle = (estimateData && estimateData.documentTitle) ? estimateData.documentTitle : 'Смета на ремонт';
        const titleSafe = escapeHtmlText(docTitle);
        let html = `
            <div class="estimate-doc-title">${titleSafe}</div>
            <table class="estimate-table">
                <thead>
                    <tr>
                        <th class="est-actions-col"><span class="est-actions-col-label">Действия</span></th>
                        <th>Наименование работ</th>
                        <th>Расценка руб</th>
                        <th>Объем</th>
                        <th>Ед.изм.</th>
                        <th>Стоимость руб</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        let totalCost = 0;
        
        estimateData.sections.forEach((section, si) => {
            html += `<tr class="category"><td colspan="6"><strong>${escapeHtmlText(section.name)}</strong></td></tr>`;
            
            // Подразделы и работы
            section.subsections.forEach((subsection, subi) => {
                // Показываем подзаголовок только если он не пустой
                if (subsection.name && subsection.name.trim() !== "") {
                    html += `<tr class="subcategory"><td colspan="6"><em>${escapeHtmlText(subsection.name)}</em></td></tr>`;
                }
                
                subsection.items.forEach((item, ii) => {
                    const rateRaw = parseFloat(item.rate);
                    const quantityRaw = parseFloat(item.quantity);
                    const rate = isNaN(rateRaw) ? 0 : rateRaw;
                    const quantity = isNaN(quantityRaw) ? 0 : quantityRaw;
                    const lineCost = item.cost !== undefined && item.cost !== null && !isNaN(Number(item.cost))
                        ? Math.round(Number(item.cost))
                        : Math.round(rate * quantity);
                    totalCost += lineCost;
                    const idSuf = `${si}_${subi}_${ii}`;
                    html += buildEstimateWorkRowHtml(idSuf, item);
                });
            });

            if (section.name === ESTIMATE_ADDITIONAL_SECTION_NAME && section.subsections.some(function (sub) {
                return sub.items && sub.items.length > 0;
            })) {
                html += buildEstimateGiftNoteRowHtml();
            }
        });
        
        // Итоговая стоимость
        html += `
                </tbody>
                <tfoot>
                    <tr class="estimate-total">
                        <td></td>
                        <td><strong>Итоговая стоимость работ:</strong></td>
                        <td colspan="3"></td>
                        <td><strong><span class="estimate-total-sum">${totalCost.toLocaleString('ru-RU')} ₽</span></strong></td>
                    </tr>
                </tfoot>
            </table>
        `;

        return html;
    }

function exportEstimateToExcel(estimateData) {
        const docTitle = (estimateData && estimateData.documentTitle) ? estimateData.documentTitle : 'Подробная смета на ремонт';
        const titleSafe = escapeHtmlText(docTitle);
        const addrPart = sanitizeEstimateFilenamePart(estimateData && estimateData.address ? estimateData.address : '');
        const dateStr = new Date().toISOString().split('T')[0];
        const downloadFilename = addrPart
            ? ('смета_ремонта_' + addrPart.replace(/\s+/g, '_') + '_' + dateStr + '.xls')
            : ('смета_ремонта_' + dateStr + '.xls');

        // Создаем HTML таблицу с красивым форматированием
        let htmlContent = `
            <!DOCTYPE html>
            <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
            <head>
                <meta charset="UTF-8">
                <style>
                    table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                    th { background-color: #4472C4; color: white; font-weight: bold; text-align: center; }
                    .category { background-color: #D9E2F3 !important; font-weight: normal !important; color: #2F5597 !important; padding: 8px; }
                    .subcategory { background-color: #E7F0FD; font-weight: bold; color: #2F5597; }
                    .number { text-align: right; }
                    .center { text-align: center; }
                    .total { background-color: #FFE699; font-weight: bold; color: #B8860B; }
                    .work-item { background-color: #F8F9FA; }
                    .work-item:nth-child(even) { background-color: #FFFFFF; }
                </style>
            </head>
            <body>
                <h2 style="text-align: center; color: #2F5597;">${titleSafe}</h2>
                <table>
                    <thead>
                        <tr>
                            <th style="width: 50%;">Наименование работ</th>
                            <th style="width: 15%;">Расценка руб</th>
                            <th style="width: 10%;">Объем</th>
                            <th style="width: 10%;">Ед.изм.</th>
                            <th style="width: 15%;">Стоимость руб</th>
                        </tr>
                    </thead>
                    <tbody>
        `;
        
        let totalCost = 0;
        
        estimateData.sections.forEach(section => {
            htmlContent += estimateExcelCategoryRowHtml(section.name);
            
            // Подразделы и работы
            section.subsections.forEach(subsection => {
                if (subsection.name && String(subsection.name).trim() !== '') {
                    htmlContent += estimateExcelSubcategoryRowHtml(subsection.name);
                }

                subsection.items.forEach(item => {
                    const rate = parseEstimateInputNumber(item.rate);
                    const quantity = parseEstimateInputNumber(item.quantity);
                    const rEff = isNaN(rate) ? 0 : rate;
                    const qEff = isNaN(quantity) ? 0 : quantity;
                    const cost = item.cost !== undefined && item.cost !== null && !isNaN(Number(item.cost))
                        ? Math.round(Number(item.cost))
                        : Math.round(rEff * qEff);
                    totalCost += cost;

                    htmlContent += `
                        <tr class="work-item">
                            <td>${escapeHtmlText(item.name)}</td>
                            ${estimateExcelNumericCellHtml(rEff)}
                            ${estimateExcelQtyCellHtml(qEff)}
                            <td class="center">${escapeHtmlText(item.unit != null ? item.unit : '')}</td>
                            ${estimateExcelNumericCellHtml(cost)}
                        </tr>
                    `;
                });
            });

            if (section.name === ESTIMATE_ADDITIONAL_SECTION_NAME && section.subsections.some(function (sub) {
                return sub.items && sub.items.length > 0;
            })) {
                htmlContent += buildEstimateGiftNoteExcelRowHtml();
            }

            htmlContent += `<tr><td colspan="5">&nbsp;</td></tr>`; // Пустая строка между разделами
        });
        
        const ratePctNote = estimateData && estimateData.ratePercent
            ? clampEstimateRatePercent(estimateData.ratePercent)
            : 0;
        if (ratePctNote !== 0) {
            const sign = ratePctNote > 0 ? '+' : '';
            htmlContent += `
            <tr class="subcategory"><td colspan="5">Расценки скорректированы: ${sign}${ratePctNote}% (округление до рубля)</td></tr>
        `;
        }
        // Итоговая стоимость
        htmlContent += `
            <tr class="total">
                <td>Итоговая стоимость работ:</td>
                <td colspan="3"></td>
                <td class="number" x:num="${totalCost}" style="mso-number-format:'0';text-align:right">${totalCost}</td>
            </tr>
        `;
        
        htmlContent += `
                    </tbody>
                </table>
            </body>
            </html>
        `;
        
        downloadExcelHtmlFile(htmlContent, downloadFilename);
    }

function excelExportFilenameStem(prefix, address) {
    const addrPart = sanitizeEstimateFilenamePart(address);
    const dateStr = new Date().toISOString().split('T')[0];
    return addrPart
        ? (prefix + '_' + addrPart.replace(/\s+/g, '_') + '_' + dateStr + '.xls')
        : (prefix + '_' + dateStr + '.xls');
}

function downloadExcelHtmlFile(htmlContent, downloadFilename) {
    const blob = new Blob([htmlContent], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', downloadFilename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function spravCalculateEstimate(apartmentTypeForGarbage) {
    return buildEstimateTableHtml(generateDetailedEstimateData(apartmentTypeForGarbage));
}

/** Часов в рабочем дне графика (см. График_работ_формулы_времени.txt). */
const SCHEDULE_H_DAY = 8;

/**
 * Палитра кольцевой диаграммы (вариант 7, График_работ_варианты.html) + оттенки для этапов вне демо.
 */
const SCHEDULE_RING_PALETTE = [
    '#3d5a80', '#4a6fa5', '#5b82b8', '#6b8cce', '#0d9488', '#b45309',
    '#7c3aed', '#be185d', '#64748b', '#0ea5e9', '#84cc16', '#f59e0b',
    '#5278a8', '#8fa8d8', '#10a89a', '#d08030', '#9668e8', '#d64a7d',
    '#8898a8', '#30c8f8', '#98e040', '#f0a820'
];

/** Цвет по типу этапа (палитра кольца v7). */
const SCHEDULE_RING_COLOR_BY_CATALOG = {
    prep: 0,
    demolition: 1,
    partitions: 12,
    wallPlaster: 2,
    chasing: 3,
    wiring: 4,
    sealing: 5,
    heating: 13,
    floorScreed: 6,
    doorways: 14,
    wallPutty: 7,
    bathPlaster: 15,
    boxes: 16,
    tile: 8,
    plumbing: 9,
    baguette: 17,
    wallpaper: 18,
    wallPaint: 19,
    ceilingFinish: 20,
    armstrong: 20,
    floorCover: 10,
    outlets: 21,
    stretchCeiling: 5,
    lighting: 11,
    windowsDoors: 22,
    final: 23
};

function scheduleRingBarColor(st, listIndex) {
    const slot = SCHEDULE_RING_COLOR_BY_CATALOG[st.catalogKey];
    const idx = slot != null ? slot : listIndex;
    return SCHEDULE_RING_PALETTE[idx % SCHEDULE_RING_PALETTE.length];
}

function scheduleRh(x) {
    if (x == null || isNaN(x) || x <= 0) return 0;
    return Math.max(1, Math.round(x));
}

/** Единая норма грунтовки в графике: (S×0,08+2)/4 ч (в 4 раза меньше прежней «под штукатурку»). */
function schedulePrimerRawHours(sqm) {
    const s = typeof sqm === 'number' ? sqm : parseFloat(String(sqm).replace(',', '.'));
    if (isNaN(s) || s <= 0) return 0;
    return (s * 0.08 + 2) / 4;
}

function schedulePrimerTask(name, sqm, sLabel) {
    return {
        name: name,
        raw: schedulePrimerRawHours(sqm),
        formula: '(' + (sLabel || 'S') + '×0,08+2)/4'
    };
}

function scheduleSumServiceQty(arr) {
    let s = 0;
    (arr || []).forEach(function (item) {
        const q = parseFloat(String(item.quantity != null ? item.quantity : 1).replace(',', '.'));
        s += (!isNaN(q) && q > 0) ? q : 1;
    });
    return s;
}

/** «Точки» el.Points для формул штробления/кабеля: розетки + выключатели + терморегулятор (без п.м. и монтажных строк). */
function scheduleSumElectricalPoints(electrical) {
    if (!electrical || !electrical.length) return 0;
    const POINT_TYPES = new Set(['outlets', 'switches', 'thermostat']);
    let s = 0;
    electrical.forEach(function (item) {
        if (!item || !POINT_TYPES.has(item.type)) return;
        const q = parseFloat(String(item.quantity != null ? item.quantity : 1).replace(',', '.'));
        s += (!isNaN(q) && q > 0) ? q : 1;
    });
    return s;
}

function scheduleSumAdditionalFloorSqmByType(floorType) {
    let sum = 0;
    const lists = [selectedMaterials.additionalFloors, selectedMaterials.additionalBathroomFloors];
    lists.forEach(function (arr) {
        (arr || []).forEach(function (m) {
            if (!m || m.type !== floorType) return;
            const sq = scheduleAreaFromMaterial(m);
            if (sq > 0) sum += sq;
        });
    });
    return sum;
}

function scheduleLivingFloorCoveringArea(calc) {
    const sm = selectedMaterials;
    let area = 0;
    const variants = sm.floorsVariants && sm.floorsVariants.length
        ? sm.floorsVariants
        : (sm.floors ? [sm.floors] : []);
    variants.forEach(function (x) {
        if (!x || x.type === 'skirting') return;
        const sq = x.area ? parseAreaStringToSqm(x.area) : null;
        if (sq != null && sq > 0) area += sq;
    });
    if (!(area > 0)) {
        area = (calc.materials && calc.materials.laminate) || calc.livingArea || 0;
    }
    return area;
}

/** Площадь укладки плитки/керамогранита/мозаики для этапа «Плиточные работы» (как tileTotalArea в корзине). */
function scheduleTileLayingAreaSqm(calc) {
    const sm = selectedMaterials;
    if (!sm || !hasTileWorkScope(sm)) return 0;
    const c = calc || {};
    const mats = c.materials || {};
    let wallMaterialArea = c.totalWallArea || 0;
    if (sm.walls && sm.walls.area) {
        const w = parseAreaStringToSqm(sm.walls.area);
        if (w != null && w > 0) wallMaterialArea = w;
    }
    const floorTileArea = mats.floorTile || 0;
    const wallTileArea = mats.wallTile || 0;
    let livingWallTile = 0;
    if (sm.wallsVariants && sm.wallsVariants.length) {
        livingWallTile = sumTileLayingAreaFromVariants(sm.wallsVariants, wallMaterialArea);
    } else if (sm.walls && isTileLayingType(sm.walls.type)) {
        const wsq = sm.walls.area ? parseAreaStringToSqm(sm.walls.area) : null;
        livingWallTile = (wsq != null && wsq > 0) ? wsq : wallMaterialArea;
    }
    let apronSqm = 0;
    (sm.additionalWalls || []).forEach(function (m) {
        if (m && m.type === 'ceramicGraniteApron' && m.area) {
            const sq = parseAreaStringToSqm(m.area);
            if (sq != null && sq > 0) apronSqm += sq;
        }
    });
    const bathFloor = sumTileLayingAreaFromVariants(getBathroomFloorFinishVariants(sm), floorTileArea);
    const bathWall = sumTileLayingAreaFromVariants(getBathroomWallTileVariants(sm), wallTileArea);
    return bathFloor + bathWall + livingWallTile + apronSqm;
}

function scheduleAreaFromMaterial(m) {
    if (!m || !m.area) return 0;
    const sq = parseAreaStringToSqm(m.area);
    return sq != null && sq > 0 ? sq : 0;
}

/** Периметр плинтуса для графика (п.м.): план, поле плинтуса или 4×√Sпол. */
function scheduleSkirtingPerimeterM(calc) {
    let totalP = skirtingPerimeterMFromCalcObj(calc);
    (selectedMaterials.additionalFloors || []).forEach(function (m) {
        if (!m || m.type !== 'skirting') return;
        const p = parseSkirtingPerimeterFromMaterial(m);
        if (p > 0) totalP = p;
    });
    if (totalP <= 0 && calc) {
        const lam = (calc.materials && calc.materials.laminate) || calc.livingArea || 0;
        if (lam > 0) totalP = floorPerimeterMFromAreaSqm(lam);
    }
    return totalP;
}

const SCHEDULE_SKIRTING_M_PER_HOUR = 15;

function scheduleBuildVars(calc) {
    const c = calc || {};
    const mats = c.materials || {};
    const wa = c.wallAreas;
    let livingWall = 0;
    if (wa) livingWall = (wa.living || 0) + (wa.kitchen || 0) + (wa.hallway || 0);
    else livingWall = Math.max(0, (c.totalWallArea || 0) - (mats.wallTile || 0));
    const bathroomWall = mats.wallTile || (c.bathroomCalc && c.bathroomCalc.wallArea) || 0;
    const livingFloorFallback = mats.laminate || c.livingArea || 0;
    const bathroomFloor = mats.floorTile || (c.bathroomCalc && c.bathroomCalc.floorArea) || 0;
    const ceilingArea = c.totalCeilingArea || mats.ceiling || 0;
    let totalArea = c.totalApartmentArea || c.totalFloorArea || 0;
    if (!(totalArea > 0)) totalArea = livingFloorFallback + bathroomFloor;
    if (!(totalArea > 0)) totalArea = 50;
    const tileArea = scheduleTileLayingAreaSqm(c);
    let screedArea = scheduleSumAdditionalFloorSqmByType('screed');
    let selfLevelArea = scheduleSumAdditionalFloorSqmByType('selfLeveling');
    let wallTileBoxQty = 0;
    (selectedMaterials.additionalWallTile || []).forEach(function (m) {
        if (m.type === 'box') wallTileBoxQty += parseInt(String(m.quantity), 10) || 0;
    });
    let electricalPoints = scheduleSumElectricalPoints(selectedMaterials.electrical);
    if (selectedMaterials.electrical && selectedMaterials.electrical.length > 0 && electricalPoints <= 0) {
        electricalPoints = 1;
    }
    const plumbingItems = scheduleSumServiceQty(selectedMaterials.plumbing);
    const lightingItems = scheduleSumServiceQty(selectedMaterials.lighting);
    const hasElectrical = selectedMaterials.electrical && selectedMaterials.electrical.length > 0;
    const hasPlumbing = selectedMaterials.plumbing && selectedMaterials.plumbing.length > 0;
    const hasPanel = hasElectrical && selectedMaterials.electrical.some(function (e) { return e.type === 'panel'; });
    const hasJunctionBoxes = hasElectrical && selectedMaterials.electrical.some(function (e) { return e.type === 'junctionBoxes'; });
    const laminateArea = scheduleLivingFloorCoveringArea(c);
  return {
        wallArea: livingWall,
        bathroomWall: bathroomWall,
        floorArea: laminateArea,
        bathroomFloor: bathroomFloor,
        ceilingArea: ceilingArea,
        totalArea: totalArea,
        tileArea: tileArea,
        laminateArea: laminateArea,
        electricalPoints: electricalPoints,
        plumbingItems: plumbingItems,
        lightingItems: lightingItems,
        screedArea: screedArea,
        selfLevelArea: selfLevelArea,
        wallTileBoxQty: wallTileBoxQty,
        hasElectrical: hasElectrical,
        hasPlumbing: hasPlumbing,
        hasPanel: hasPanel,
        hasJunctionBoxes: hasJunctionBoxes,
        skirtingPerimeterM: scheduleSkirtingPerimeterM(c)
    };
}

function scheduleBuildFinalStageTitle(tasks) {
    const names = (tasks || []).map(function (t) { return t.name || ''; });
    const hasLight = names.some(function (n) { return n.indexOf('Светильники') >= 0; });
    const hasDoors = names.some(function (n) { return n.indexOf('двери') >= 0; });
    const hasKitchen = names.some(function (n) { return n.indexOf('Кухня') >= 0; });
    const parts = [];
    if (hasLight) parts.push('Освещение');
    if (hasDoors) parts.push('двери');
    if (hasKitchen) parts.push('кухня, мебель');
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    if (parts.length > 1) return parts.join(', ').replace(/^./, function (c) { return c.toUpperCase(); });
    return 'Финальные монтажи';
}

function schedulePushStage(stages, catalogKey, name, taskDefs) {
    const tasks = [];
    (taskDefs || []).forEach(function (td) {
        if (!td || td.skip) return;
        const raw = td.raw;
        if (raw == null || isNaN(raw) || raw <= 0) return;
        const hours = scheduleRh(raw);
        if (hours <= 0) return;
        tasks.push({ name: td.name, hours: hours, formula: td.formula || '', rawHours: raw });
    });
    if (!tasks.length) return;
    const totalHours = tasks.reduce(function (s, t) { return s + t.hours; }, 0);
    stages.push({
        catalogKey: catalogKey,
        name: name,
        tasks: tasks,
        totalHours: totalHours,
        days: Math.max(1, Math.ceil(totalHours / SCHEDULE_H_DAY))
    });
}

/** Нормы часов на перегородки (ориентир: ставки сметы / 500 ₽/ч). ПГП/пеноблок: 15 м²/день; кирпич: 7; ГКЛ на каркасе: 20 м²/день (8 ч). */
const SCHEDULE_PARTITION_BLOCK_SQM_PER_DAY = 15;
const SCHEDULE_PARTITION_BRICK_SQM_PER_DAY = 7;
const SCHEDULE_PARTITION_GYPSUM_FRAME_SQM_PER_DAY = 20;
const SCHEDULE_PARTITION_H_PER_SQM = {
    pgb: SCHEDULE_H_DAY / SCHEDULE_PARTITION_BLOCK_SQM_PER_DAY,
    foam: SCHEDULE_H_DAY / SCHEDULE_PARTITION_BLOCK_SQM_PER_DAY,
    brick: SCHEDULE_H_DAY / SCHEDULE_PARTITION_BRICK_SQM_PER_DAY,
    gypsumFrame: SCHEDULE_H_DAY / SCHEDULE_PARTITION_GYPSUM_FRAME_SQM_PER_DAY
};
const SCHEDULE_PARTITION_H_PER_BOX = 3.8;

function schedulePartitionTaskDefs(partitions) {
    const tasks = [];
    (partitions || []).forEach(function (p) {
        if (!p) return;
        if (p.type === 'gypsumBox' && p.unit === 'шт.') {
            const n = parseInt(String(p.quantity), 10);
            const nn = (!isNaN(n) && n > 0) ? n : 1;
            tasks.push({ name: p.name, raw: nn * SCHEDULE_PARTITION_H_PER_BOX, formula: 'N×3,8' });
            return;
        }
        const q = parseFloat(String(p.quantity != null ? p.quantity : '').replace(',', '.'));
        const qq = (!isNaN(q) && q > 0) ? q : 1;
        const h = SCHEDULE_PARTITION_H_PER_SQM[p.type] || 2;
        let formula;
        if (p.type === 'pgb' || p.type === 'foam') formula = 'S×8/15 (15 м²/день)';
        else if (p.type === 'brick') formula = 'S×8/7 (7 м²/день)';
        else if (p.type === 'gypsumFrame') formula = 'S×8/20 (20 м²/день)';
        else formula = 'S×' + String(h).replace('.', ',');
        tasks.push({ name: p.name, raw: qq * h, formula: formula });
    });
    return tasks;
}

/** Подработы графика по выбранному освещению (названия как в смете). */
const SCHEDULE_LIGHT_TASK_NAMES = {
    spots: 'Монтаж точечных светильников',
    chandelier: 'Установка люстры',
    led: 'Установка LED панелей',
    track: 'Установка трековых светильников',
    sconce: 'Установка бра',
    floor: 'Установка торшера'
};
const SCHEDULE_LIGHT_ORDER = ['spots', 'chandelier', 'led', 'track', 'sconce', 'floor'];

function scheduleLightingTaskDefs(lighting) {
    const byType = {};
    (lighting || []).forEach(function (light) {
        if (!light || !light.type) return;
        byType[light.type] = light;
    });
    const tasks = [];
    let addedBase = false;
    SCHEDULE_LIGHT_ORDER.forEach(function (typeKey) {
        const light = byType[typeKey];
        if (!light) return;
        const qty = parseInt(light.quantity, 10) || 0;
        if (qty <= 0) return;
        let raw = qty * 1.2;
        let formula = 'N×1,2';
        if (!addedBase) {
            raw += 2;
            formula += '+2';
            addedBase = true;
        }
        tasks.push({
            name: SCHEDULE_LIGHT_TASK_NAMES[typeKey] || light.name,
            raw: raw,
            formula: formula
        });
    });
    return tasks;
}

/**
 * График работ по формулам из График_работ_формулы_времени.txt.
 * calc — объект площадей плана; selectedMaterials должен быть уже заполнен applyCheckedSubtopics.
 */
function buildScheduleData(calc) {
    const v = scheduleBuildVars(calc);
    const stages = [];
    const sm = selectedMaterials;
    const hasDemolition = sm.demolition && sm.demolition.length > 0;
    const hasPartitions = sm.partitions && sm.partitions.length > 0;
    const hasWallPlaster = sm.additionalWalls && sm.additionalWalls.some(function (m) { return m.type === 'plaster'; });
    const hasWallPutty = sm.additionalWalls && sm.additionalWalls.some(function (m) { return isWallPuttySpravType(m.type); });
    const wallVariants = sm.wallsVariants && sm.wallsVariants.length ? sm.wallsVariants : (sm.walls ? [sm.walls] : []);
    const hasWallWallpaper = wallVariants.some(function (w) { return w && w.type === 'wallpaper'; });
    const hasWallPaintDecor = wallVariants.some(function (w) { return w && (w.type === 'paint' || w.type === 'decorative'); });
    const hasWallFinish = hasWallWallpaper || hasWallPaintDecor || hasWallPutty;
    const hasBathPlaster = sm.additionalWallTile && sm.additionalWallTile.some(function (m) { return m.type === 'plaster'; });
    const hasTileWork = hasTileWorkScope(sm);
    const hasHeating = sm.plumbing && sm.plumbing.some(function (p) { return p.type === 'heating' || p.type === 'towelwarmer'; });
    const hasStretchCeiling = sm.ceilings && sm.ceilings.some(function (c) { return c.type === 'stretch' || c.type === 'fabric'; });
    const hasArmstrongCeiling = sm.ceilings && sm.ceilings.some(function (c) { return c.type === 'armstrong'; });
    const hasPlasterPaintCeiling = sm.ceilings && sm.ceilings.some(function (c) {
        return c.type === 'plasterCeiling' || c.type === 'paintCeiling' || c.type === 'puttyCeiling';
    });
    const hasFloorCovering = Boolean(sm.floors) || (sm.floorsVariants && sm.floorsVariants.length > 0);
    const hasSkirting = sm.additionalFloors && sm.additionalFloors.some(function (m) { return m.type === 'skirting'; });
    const hasOutletsSwitches = sm.electrical && sm.electrical.some(function (e) {
        return e.type === 'outlets' || e.type === 'switches';
    });
    const hasLighting = sm.lighting && sm.lighting.length > 0;
    const hasMirrors = sm.plumbing && sm.plumbing.some(function (p) { return p.type === 'mirrors'; });
    const hasKitchenSchedule = sm.plumbing && sm.plumbing.some(function (p) {
        return p.type === 'kitchensink' || p.type === 'dishwasher';
    });

    schedulePushStage(stages, 'prep', 'Подготовка и замеры', [
        { name: 'Обмеры, план, разметка трасс', raw: 8, formula: '8' }
    ]);

    if (hasDemolition) {
        schedulePushStage(stages, 'demolition', 'Демонтаж', [
            { name: 'Демонтаж покрытий, старых перегородок, сантехники, проводки', raw: Math.max(8, v.totalArea * 0.65), formula: 'max(8, S×0,65)' },
            { name: 'Вынос мусора и подготовка площадки', raw: Math.max(4, v.totalArea * 0.12), formula: 'max(4, S×0,12)' }
        ]);
    }

    if (hasPartitions) {
        schedulePushStage(stages, 'partitions', 'Устройство перегородок', schedulePartitionTaskDefs(sm.partitions));
    }

    if (hasWallPlaster && v.wallArea > 0) {
        schedulePushStage(stages, 'wallPlaster', 'Грунтовка и штукатурка стен (жилые)', [
            schedulePrimerTask('Грунтовка под штукатурку', v.wallArea, 'Sстен'),
            { name: 'Штукатурка стен (вывод плоскостей)', raw: v.wallArea * 0.38, formula: 'Sстен×0,38' }
        ]);
    }

    if (v.hasElectrical || v.hasPlumbing) {
        const chaseTasks = [];
        if (v.hasElectrical) {
            chaseTasks.push({
                name: 'Штробление под подрозетники и каналы под кабель',
                raw: (v.electricalPoints * 1.25 + 4) / 10,
                formula: '(точки×1,25+4)/10'
            });
        }
        if (v.hasPlumbing) {
            chaseTasks.push({
                name: 'Штробление под трубы ВС и канализации',
                raw: (v.plumbingItems * 2.2 + 6) / 10,
                formula: '(сантех×2,2+6)/10'
            });
        }
        schedulePushStage(stages, 'chasing', 'Штробление (электрика и сантехника)', chaseTasks);
    }

    if (v.hasElectrical || v.hasPlumbing) {
        const wireTasks = [];
        if (v.hasElectrical) {
            let tCable = v.electricalPoints * 0.95;
            if (v.hasPanel) tCable += 10;
            if (v.hasJunctionBoxes) tCable += 6;
            wireTasks.push({
                name: 'Прокладка кабеля, монтаж в штробах',
                raw: tCable / 10,
                formula: '(точки×0,95[+щит][+РК])/10'
            });
        }
        if (v.hasPlumbing) {
            wireTasks.push({
                name: 'Прокладка труб ВС и канализации',
                raw: (v.plumbingItems * 2.6 + 8) / 10,
                formula: '(сантех×2,6+8)/10'
            });
        }
        schedulePushStage(stages, 'wiring', 'Прокладка коммуникаций', wireTasks);
    }

    if (v.hasElectrical || v.hasPlumbing) {
        const sealTasks = [];
        if (v.hasElectrical) {
            sealTasks.push({
                name: 'Замазка штроб и подрозетников (электрика)',
                raw: (v.electricalPoints * 0.45 + 6) / 10,
                formula: '(точки×0,45+6)/10'
            });
        }
        if (v.hasPlumbing) {
            sealTasks.push({
                name: 'Замазка штроб сантехники',
                raw: (v.plumbingItems * 1.3 + 6) / 10,
                formula: '(сантех×1,3+6)/10'
            });
        }
        schedulePushStage(stages, 'sealing', 'Замазка штроб и заделка гнёзд', sealTasks);
    }

    if (hasHeating) {
        schedulePushStage(stages, 'heating', 'Отопление', [
            { name: 'Монтаж радиаторов / полотенцесушителя', raw: 12, formula: '12' }
        ]);
    }

    if (v.screedArea > 0 || v.selfLevelArea > 0) {
        const floorPrep = [];
        if (v.screedArea > 0) {
            floorPrep.push(schedulePrimerTask('Грунтовка перед стяжкой', v.screedArea, 'Sстяж'));
            floorPrep.push({ name: 'Устройство стяжки', raw: v.screedArea * 0.14 + 8, formula: 'Sстяж×0,14+8' });
        }
        if (v.selfLevelArea > 0) {
            floorPrep.push(schedulePrimerTask('Грунтовка перед наливным', v.selfLevelArea, 'Sналив'));
            floorPrep.push({ name: 'Наливной пол', raw: v.selfLevelArea * 0.11 + 6, formula: 'Sналив×0,11+6' });
        }
        schedulePushStage(stages, 'floorScreed', 'Грунтовка пола, стяжка / наливной', floorPrep);
    }

    if (hasWallPutty && v.wallArea > 0) {
        const puttyPaintOnly = sm.additionalWalls && sm.additionalWalls.some(function (m) { return m.type === 'puttyPaint'; })
            && !(sm.additionalWalls.some(function (m) { return m.type === 'puttyWallpaper' || m.type === 'putty'; }));
        const puttyLayerFactor = puttyPaintOnly ? 3 : 2;
        schedulePushStage(stages, 'wallPutty', 'Грунтовка, шпаклёвка, шлифовка', [
            schedulePrimerTask('Грунтовка перед шпаклёвкой', v.wallArea, 'Sстен'),
            { name: 'Шпаклёвка стен', raw: 2 * puttyLayerFactor * (v.wallArea * 0.22) / 3, formula: '2×' + puttyLayerFactor + '×(S×0,22)/3' },
            { name: 'Шлифовка', raw: 2 * (v.wallArea * 0.09) / 3, formula: '2×(S×0,09)/3' }
        ]);
    }

    if (hasBathPlaster && v.bathroomWall > 0) {
        schedulePushStage(stages, 'bathPlaster', 'Подготовка санузла под плитку', [
            schedulePrimerTask('Грунтовка перед плиткой', v.bathroomWall, 'Sсан'),
            { name: 'Штукатурка санузла под плитку', raw: v.bathroomWall * 0.28 + 4, formula: 'Sсан×0,28+4' }
        ]);
    }

    if (v.wallTileBoxQty > 0) {
        schedulePushStage(stages, 'boxes', 'Монтаж коробов', [
            { name: 'Устройство коробов', raw: 5.5 * v.wallTileBoxQty + 4, formula: '5,5×N+4' }
        ]);
    }

    if (hasTileWork && v.tileArea > 0) {
        const tilePrimerSqm = hasBathPlaster
            ? Math.max(0, v.tileArea - v.bathroomWall)
            : v.tileArea;
        const tileTasks = [];
        if (tilePrimerSqm > 0) {
            tileTasks.push(schedulePrimerTask('Грунтовка перед плиткой', tilePrimerSqm, 'Sплит'));
        }
        tileTasks.push(
            { name: 'Укладка плитки / керамогранита', raw: v.tileArea * 1.1, formula: 'Sплит×1,1' },
            { name: 'Затирка швов', raw: v.tileArea * 0.28, formula: 'Sплит×0,28' }
        );
        schedulePushStage(stages, 'tile', 'Плиточные работы', tileTasks);
    }

    if (v.hasPlumbing) {
        const plRate = hasTileWork ? 3.5 : 3;
        const plMin = hasTileWork ? 8 : 6;
        const plTasks = [
            { name: hasTileWork ? 'Установка приборов (после плитки)' : 'Установка приборов (без плитки)', raw: Math.max(plMin, v.plumbingItems * plRate), formula: 'max(' + plMin + ', N×' + plRate + ')' }
        ];
        if (hasMirrors) {
            plTasks.push({ name: 'Навес зеркал и полок', raw: 6, formula: '6' });
        }
        schedulePushStage(stages, 'plumbing', 'Сантехника', plTasks);
    }

    if (hasStretchCeiling && v.ceilingArea > 0) {
        schedulePushStage(stages, 'baguette', 'Багет под натяжной', [
            { name: 'Периметр / подготовка багета', raw: v.ceilingArea * 0.04 + 6, formula: 'Sпот×0,04+6' }
        ]);
    }

    if (hasWallWallpaper && v.wallArea > 0) {
        const wallpaperSqm = computeRadugaWallpaperPaintSqm(sm) || v.wallArea;
        schedulePushStage(stages, 'wallpaper', 'Финиш стен: обои', [
            schedulePrimerTask('Грунтовка пропиткой Радуга-27', wallpaperSqm, 'Sоб'),
            { name: 'Поклейка обоев', raw: 4 * (v.wallArea * 0.15) / 3, formula: '4×(S×0,15)/3' }
        ]);
    }

    if (hasWallPaintDecor && v.wallArea > 0) {
        const wallPaintTasks = [];
        const paintWallSqm = computeRadugaWallpaperPaintSqm(sm) + computeRadugaDecorativeWallSqm(sm);
        if (paintWallSqm > 0) {
            wallPaintTasks.push(schedulePrimerTask('Грунтовка пропиткой Радуга-27', paintWallSqm, 'Sоб/крас'));
        }
        wallPaintTasks.push({ name: 'Окраска / декор', raw: v.wallArea * 0.2 + 4, formula: 'S×0,2+4' });
        schedulePushStage(stages, 'wallPaint', 'Финиш стен: краска / декор', wallPaintTasks);
    }

    if (hasPlasterPaintCeiling && v.ceilingArea > 0) {
        schedulePushStage(stages, 'ceilingFinish', 'Отделка потолка (без натяжного)', [
            { name: 'Подготовка и окраска / штукатурка потолка', raw: v.ceilingArea * 0.16 + 4, formula: 'Sпот×0,16+4' }
        ]);
    }

    if (hasArmstrongCeiling && v.ceilingArea > 0) {
        schedulePushStage(stages, 'armstrong', 'Потолок Армстронг', [
            { name: 'Монтаж подвесного потолка Армстронг', raw: v.ceilingArea * 0.16 + 4, formula: 'Sпот×0,16+4' }
        ]);
    }

    if ((hasFloorCovering || hasSkirting) && v.laminateArea > 0) {
        const floorTasks = [];
        if (hasFloorCovering) {
            floorTasks.push(schedulePrimerTask('Грунтовка перед укладкой', v.laminateArea, 'Sпол'));
            floorTasks.push({ name: 'Укладка покрытия', raw: 2 * v.laminateArea * 0.13, formula: '2×S×0,13' });
        }
        if (hasSkirting || hasFloorCovering) {
            const skPerim = v.skirtingPerimeterM > 0 ? v.skirtingPerimeterM : floorPerimeterMFromAreaSqm(v.laminateArea);
            if (skPerim > 0) {
                floorTasks.push({
                    name: 'Плинтус',
                    raw: skPerim / SCHEDULE_SKIRTING_M_PER_HOUR,
                    formula: 'P/' + SCHEDULE_SKIRTING_M_PER_HOUR
                });
            }
        }
        schedulePushStage(stages, 'floorCover', 'Напольные покрытия', floorTasks);
    }

    if (hasOutletsSwitches) {
        schedulePushStage(stages, 'outlets', 'Розетки и выключатели (после финиша)', [
            { name: 'Установка механизмов / лицевых частей', raw: (v.electricalPoints * 0.55 + 4) / 10, formula: '(точки×0,55+4)/10' }
        ]);
    }

    if (hasStretchCeiling && v.ceilingArea > 0) {
        schedulePushStage(stages, 'stretchCeiling', 'Натяжной потолок', [
            { name: 'Монтаж полотна', raw: v.ceilingArea * 0.11 + 8, formula: 'Sпот×0,11+8' }
        ]);
    }

    if (hasLighting) {
        const lightTasks = scheduleLightingTaskDefs(sm.lighting);
        if (lightTasks.length > 0) {
            schedulePushStage(stages, 'lighting', 'Освещение', lightTasks);
        }
    }

    if (sm.windowsDoors && sm.windowsDoors.length > 0) {
        const wdOrder = ['openings', 'windows', 'slopes', 'sills', 'doors', 'trim', 'extensions', 'locks', 'other'];
        const wdTasks = [];
        wdOrder.forEach(function (typeKey) {
            const item = (sm.windowsDoors || []).find(function (w) { return w.type === typeKey; });
            if (!item) return;
            const hPer = SCHEDULE_WD_HOURS_PER_UNIT[typeKey];
            if (!hPer) return;
            const qty = parseInt(item.quantity, 10) || 0;
            if (qty <= 0) return;
            const spec = WINDOWS_DOORS_WORK_RATES[typeKey];
            wdTasks.push({
                name: spec ? spec.name : item.name,
                raw: qty * hPer,
                formula: 'N×' + String(hPer).replace('.', ',')
            });
        });
        if (wdTasks.length > 0) {
            schedulePushStage(stages, 'windowsDoors', 'Окна и двери', wdTasks);
        }
    }

    const finalTasks = [];
    if (hasKitchenSchedule) {
        finalTasks.push({ name: 'Кухня и навесная мебель', raw: 20, formula: '20' });
    }
    if (finalTasks.length > 0) {
        schedulePushStage(stages, 'final', scheduleBuildFinalStageTitle(finalTasks), finalTasks);
    }

    stages.forEach(function (st, i) {
        st.num = i + 1;
    });

    let dayCursor = 1;
    let totalHours = 0;
    stages.forEach(function (st) {
        st.startDay = dayCursor;
        st.endDay = dayCursor + st.days - 1;
        dayCursor = st.endDay + 1;
        totalHours += st.totalHours;
    });

    return {
        stages: stages,
        variables: v,
        totalHours: totalHours,
        totalDays: stages.length ? dayCursor - 1 : 0,
        hDay: SCHEDULE_H_DAY
    };
}

function scheduleStageCountLabel(n) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m100 >= 11 && m100 <= 14) return 'этапов';
    if (m10 === 1) return 'этап';
    if (m10 >= 2 && m10 <= 4) return 'этапа';
    return 'этапов';
}

function scheduleCanvasRoundRect(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
    ctx.lineTo(x + rad, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
    ctx.lineTo(x, y + rad);
    ctx.quadraticCurveTo(x, y, x + rad, y);
    ctx.closePath();
}

function scheduleCanvasTruncate(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t + '…';
}

function scheduleTriggerPngDownload(dataUrl, filename) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

/** Копирует вычисленные стили с живого узла на клон (для PNG «как на экране»). */
function scheduleCopyComputedStyles(source, target) {
    if (!source || !target || typeof window === 'undefined') return;
    const computed = window.getComputedStyle(source);
    let css = '';
    for (let i = 0; i < computed.length; i++) {
        const key = computed[i];
        css += key + ':' + computed.getPropertyValue(key) + ';';
    }
    target.setAttribute('style', css);
    const srcKids = source.children;
    const tgtKids = target.children;
    for (let i = 0; i < srcKids.length; i++) {
        if (tgtKids[i]) scheduleCopyComputedStyles(srcKids[i], tgtKids[i]);
    }
}

/** Внешнее поле и внутренние отступы PNG при скачивании. */
const SCHEDULE_EXPORT_OUTER_MARGIN = 14;
const SCHEDULE_EXPORT_CHART_PAD = '6px 12px 6px 6px';

function scheduleExportObjectLine(address) {
    const a = address != null ? String(address).trim() : '';
    return a ? ('Объект — ' + a) : 'Объект — не указан';
}

function scheduleExportChartKindLabel(kind) {
    return kind === 'ring'
        ? 'Кольцевая диаграмма · доля часов по этапам'
        : 'Тепловая шкала · часы по этапам';
}

function scheduleExportStatsLine(scheduleData) {
    if (!scheduleData) return '';
    return scheduleData.totalHours + ' ч · ' + scheduleData.totalDays + ' календ. дн.';
}

function scheduleBuildExportHeaderElement(title, kind, scheduleData) {
    const head = document.createElement('div');
    head.style.cssText = 'margin:0 0 12px;padding:0 0 10px;border-bottom:1px solid #e2e8f0;';
    const line1 = document.createElement('div');
    line1.style.cssText = 'font:700 15px/1.35 Segoe UI,Arial,sans-serif;color:#1e3a5f;margin:0 0 4px;';
    line1.textContent = scheduleExportObjectLine(title);
    const line2 = document.createElement('div');
    line2.style.cssText = 'font:600 12px/1.4 Segoe UI,Arial,sans-serif;color:#3d5a80;margin:0 0 3px;';
    line2.textContent = scheduleExportChartKindLabel(kind);
    head.appendChild(line1);
    head.appendChild(line2);
    const stats = scheduleExportStatsLine(scheduleData);
    if (stats) {
        const line3 = document.createElement('div');
        line3.style.cssText = 'font:11px/1.35 Segoe UI,Arial,sans-serif;color:#64748b;margin:0;';
        line3.textContent = stats;
        head.appendChild(line3);
    }
    return head;
}

function scheduleDrawExportHeaderCanvas(ctx, pad, w, title, kind, scheduleData) {
    const top = pad;
    ctx.fillStyle = '#1e3a5f';
    ctx.font = 'bold 15px Segoe UI, Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(scheduleCanvasTruncate(ctx, scheduleExportObjectLine(title), w - pad * 2), pad, top + 16);
    ctx.fillStyle = '#3d5a80';
    ctx.font = '600 12px Segoe UI, Arial, sans-serif';
    ctx.fillText(scheduleExportChartKindLabel(kind), pad, top + 34);
    const stats = scheduleExportStatsLine(scheduleData);
    let ruleY = top + 44;
    if (stats) {
        ctx.fillStyle = '#64748b';
        ctx.font = '11px Segoe UI, Arial, sans-serif';
        ctx.fillText(stats, pad, top + 50);
        ruleY = top + 58;
    }
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, ruleY);
    ctx.lineTo(w - pad, ruleY);
    ctx.stroke();
    return ruleY - top + 10;
}

/** Скачать видимый блок графика (WYSIWYG — тот же HTML/CSS, что на вкладке). */
function downloadScheduleChartDomPng(liveEl, filename, onFail, title, kind, scheduleData) {
    if (!liveEl || typeof document === 'undefined') {
        if (onFail) onFail();
        return;
    }
    const off = document.createElement('div');
    off.style.cssText = 'position:fixed;left:-20000px;top:0;background:#fff;padding:0;margin:0;';
    const clone = liveEl.cloneNode(true);
    scheduleCopyComputedStyles(liveEl, clone);
    const chartWrap = document.createElement('div');
    chartWrap.style.cssText = 'box-sizing:border-box;padding:' + SCHEDULE_EXPORT_CHART_PAD + ';';
    chartWrap.appendChild(clone);
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;padding:16px 20px 16px;box-sizing:border-box;';
    box.appendChild(scheduleBuildExportHeaderElement(title, kind, scheduleData));
    box.appendChild(chartWrap);
    off.appendChild(box);
    document.body.appendChild(off);
    const exportW = Math.max(1, Math.ceil(box.scrollWidth || 1));
    const exportH = Math.max(1, Math.ceil(box.scrollHeight || 1));
    const xmlns = 'http://www.w3.org/1999/xhtml';
    const wrapper = document.createElement('div');
    wrapper.setAttribute('xmlns', xmlns);
    wrapper.style.cssText = 'background:#fff;margin:0;padding:0;width:' + exportW + 'px;height:' + exportH + 'px;box-sizing:border-box;';
    wrapper.appendChild(box);
    const serialized = new XMLSerializer().serializeToString(wrapper);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + exportW + '" height="' + exportH + '">' +
        '<foreignObject width="100%" height="100%">' + serialized + '</foreignObject></svg>';
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image();
    let done = false;
    function cleanup() {
        if (off.parentNode) off.parentNode.removeChild(off);
    }
    img.onload = function () {
        if (done) return;
        done = true;
        cleanup();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const outerM = SCHEDULE_EXPORT_OUTER_MARGIN;
        const totalW = exportW + outerM * 2;
        const totalH = exportH + outerM * 2;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(totalW * dpr);
        canvas.height = Math.round(totalH * dpr);
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, totalW, totalH);
        ctx.drawImage(img, outerM, outerM, exportW, exportH);
        scheduleTriggerPngDownload(canvas.toDataURL('image/png'), filename);
    };
    img.onerror = function () {
        if (done) return;
        done = true;
        cleanup();
        if (onFail) onFail();
    };
    img.src = url;
}

function downloadScheduleHeatPng(scheduleData, title, kind) {
    const stages = scheduleData.stages || [];
    if (!stages.length) return;
    const maxH = Math.max.apply(null, stages.map(function (st) { return st.totalHours; })) || 1;
    const rowH = 26;
    const pad = 22;
    const canvas = document.createElement('canvas');
    const dpr = Math.min(typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1, 2);
    const ctxProbe = document.createElement('canvas').getContext('2d');
    ctxProbe.font = '11px Segoe UI, Arial, sans-serif';
    const titleH = scheduleDrawExportHeaderCanvas(ctxProbe, pad, 800, title, kind || 'heat', scheduleData);
    const labelW = 260;
    const barAreaW = 380;
    const rightW = 52;
    const w = pad * 2 + labelW + barAreaW + rightW;
    const h = pad * 2 + titleH + stages.length * rowH + 8;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const headerH = scheduleDrawExportHeaderCanvas(ctx, pad, w, title, kind || 'heat', scheduleData);
    let y = pad + headerH;
    stages.forEach(function (st, i) {
        const col = scheduleRingBarColor(st, i);
        ctx.fillStyle = '#334155';
        ctx.font = '11px Segoe UI, Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(scheduleCanvasTruncate(ctx, st.num + '. ' + st.name, labelW - 8), pad, y + 15);
        const barX = pad + labelW;
        const barW = Math.max(6, (st.totalHours / maxH) * barAreaW);
        ctx.fillStyle = col;
        scheduleCanvasRoundRect(ctx, barX, y + 3, barW, 22, 4);
        ctx.fill();
        if (barW > 40) {
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 10px Segoe UI, Arial, sans-serif';
            ctx.fillText(st.totalHours + ' ч', barX + 6, y + 17);
        }
        ctx.fillStyle = '#64748b';
        ctx.font = '11px Segoe UI, Arial, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(st.days + ' дн.', w - pad, y + 15);
        ctx.textAlign = 'left';
        y += rowH;
    });
    scheduleTriggerPngDownload(canvas.toDataURL('image/png'), 'grafik-teplovaya-shkala.png');
}

function downloadScheduleRingPng(scheduleData, title, kind) {
    const stages = scheduleData.stages || [];
    if (!stages.length) return;
    const total = scheduleData.totalHours || stages.reduce(function (s, st) { return s + st.totalHours; }, 0);
    if (!total) return;
    const pad = 22;
    const ctxProbe = document.createElement('canvas').getContext('2d');
    const titleH = scheduleDrawExportHeaderCanvas(ctxProbe, pad, 900, title, kind || 'ring', scheduleData);
    const donutSize = 300;
    const rowH = 22;
    const nameColW = 260;
    const pctColW = 36;
    const legendW = 18 + nameColW + 10 + pctColW;
    const w = pad * 2 + donutSize + 16 + legendW;
    const h = pad * 2 + titleH + Math.max(donutSize, stages.length * rowH + 8);
    const canvas = document.createElement('canvas');
    const dpr = Math.min(typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const headerH = scheduleDrawExportHeaderCanvas(ctx, pad, w, title, kind || 'ring', scheduleData);
    const donutX = pad;
    const donutY = pad + headerH;
    const cx = donutX + donutSize / 2;
    const cy = donutY + donutSize / 2;
    const outerR = donutSize / 2;
    const innerR = outerR * 0.44;
    let acc = -Math.PI / 2;
    stages.forEach(function (st, i) {
        const sweep = (st.totalHours / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, outerR, acc, acc + sweep);
        ctx.arc(cx, cy, innerR, acc + sweep, acc, true);
        ctx.closePath();
        ctx.fillStyle = scheduleRingBarColor(st, i);
        ctx.fill();
        acc += sweep;
    });
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, innerR - 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1e3a5f';
    ctx.font = 'bold 20px Segoe UI, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(total), cx, cy - 4);
    ctx.font = '11px Segoe UI, Arial, sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.fillText('часов', cx, cy + 12);
    ctx.fillText(stages.length + ' этапов', cx, cy + 26);
    ctx.textAlign = 'left';
    const legendX = pad + donutSize + 16;
    const nameX = legendX + 18;
    const pctX = nameX + nameColW + 10 + pctColW;
    let ly = pad + headerH;
    stages.forEach(function (st, i) {
        const pct = Math.round((st.totalHours / total) * 100);
        const label = st.num + '. ' + st.name;
        ctx.fillStyle = scheduleRingBarColor(st, i);
        scheduleCanvasRoundRect(ctx, legendX, ly + 5, 12, 12, 3);
        ctx.fill();
        ctx.fillStyle = '#334155';
        ctx.font = '11px Segoe UI, Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(scheduleCanvasTruncate(ctx, label, nameColW), nameX, ly + 14);
        ctx.fillStyle = '#64748b';
        ctx.textAlign = 'right';
        ctx.fillText(pct + '%', pctX, ly + 14);
        ctx.textAlign = 'left';
        ly += rowH;
    });
    scheduleTriggerPngDownload(canvas.toDataURL('image/png'), 'grafik-koltsevaya-diagramma.png');
}

function downloadScheduleChartPng(scheduleData, kind, exportEl, title) {
    if (!scheduleData || !scheduleData.stages || !scheduleData.stages.length) return;
    const filename = kind === 'ring' ? 'grafik-koltsevaya-diagramma.png' : 'grafik-teplovaya-shkala.png';
    function fallbackDraw() {
        if (kind === 'ring') downloadScheduleRingPng(scheduleData, title, kind);
        else downloadScheduleHeatPng(scheduleData, title, kind);
    }
    if (exportEl) {
        downloadScheduleChartDomPng(exportEl, filename, fallbackDraw, title, kind, scheduleData);
        return;
    }
    fallbackDraw();
}

function buildScheduleHeatChartHtml(scheduleData) {
    const maxH = Math.max.apply(null, scheduleData.stages.map(function (st) { return st.totalHours; })) || 1;
    let html = '<div class="v13-heat sprav-schedule-chart-export" data-schedule-export="heat" role="img" aria-label="Тепловая шкала часов по этапам">';
    scheduleData.stages.forEach(function (st, i) {
        const pct = (st.totalHours / maxH) * 100;
        const col = scheduleRingBarColor(st, i);
        html += '<div class="v13-row">';
        html += '<span title="' + escapeHtmlText(st.name) + '">' + st.num + '. ' + escapeHtmlText(st.name) + '</span>';
        html += '<div class="v13-bar" style="width:' + pct + '%;background:' + col + '" title="дн. ' + st.startDay + '–' + st.endDay + ' · ' + st.totalHours + ' ч">' + st.totalHours + ' ч</div>';
        html += '<span class="v13-hrs">' + st.days + ' дн.</span>';
        html += '</div>';
    });
    html += '</div>';
    return html;
}

function buildScheduleRingChartHtml(scheduleData) {
    const stages = scheduleData.stages;
    const total = scheduleData.totalHours || stages.reduce(function (s, st) { return s + st.totalHours; }, 0);
    if (!total) return '';
    let acc = 0;
    const parts = [];
    stages.forEach(function (st, i) {
        const pct = (st.totalHours / total) * 100;
        const col = scheduleRingBarColor(st, i);
        parts.push(col + ' ' + acc + '% ' + (acc + pct) + '%');
        acc += pct;
    });
    let html = '<div class="v7-wrap sprav-schedule-chart-export" data-schedule-export="ring" role="img" aria-label="Кольцевая диаграмма долей часов по этапам">';
    html += '<div class="v7-donut" style="background:conic-gradient(' + parts.join(', ') + ')">';
    html += '<div class="v7-donut-hole"><strong>' + total + '</strong>часов<br>' + stages.length + ' этапов</div></div>';
    html += '<div class="v7-legend">';
    stages.forEach(function (st, i) {
        const pct = Math.round((st.totalHours / total) * 100);
        const col = scheduleRingBarColor(st, i);
        html += '<div class="v7-leg-row">';
        html += '<span class="v7-swatch" style="background:' + col + '"></span>';
        html += '<span class="v7-leg-name" title="' + escapeHtmlText(st.name) + '">' + st.num + '. ' + escapeHtmlText(st.name) + '</span>';
        html += '<span class="v7-leg-pct">' + pct + '%</span>';
        html += '</div>';
    });
    html += '</div></div>';
    return html;
}

function parseScheduleDateInput(val) {
    if (!val) return null;
    const p = String(val).split('-');
    if (p.length !== 3) return null;
    const d = new Date(+p[0], +p[1] - 1, +p[2]);
    return isNaN(d.getTime()) ? null : d;
}

function formatScheduleDate(d) {
    if (!d) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return dd + '.' + mm + '.' + d.getFullYear();
}

function addScheduleCalendarDays(d, n) {
    const r = new Date(d.getTime());
    r.setDate(r.getDate() + n);
    return r;
}

function scheduleStageMetaLabel(st, startDate) {
    const base = st.totalHours + ' ч · ' + st.days + ' дн.';
    if (!startDate) return base + ' · календарь ' + st.startDay + '–' + st.endDay;
    const ds = addScheduleCalendarDays(startDate, st.startDay - 1);
    const de = addScheduleCalendarDays(startDate, st.endDay - 1);
    return base + ' · ' + formatScheduleDate(ds) + ' — ' + formatScheduleDate(de);
}

/** Подставить календарные даты в этапы, если задана дата начала (YYYY-MM-DD); иначе — номера дней. */
function applyScheduleStartDate(scheduleData, startDateInput) {
    if (!scheduleData || !scheduleData.stages) return scheduleData;
    const startDate = parseScheduleDateInput(startDateInput);
    const iso = startDateInput && String(startDateInput).trim() ? String(startDateInput).trim() : '';
    const stages = scheduleData.stages.map(function (st) {
        const copy = Object.assign({}, st);
        copy.tasks = st.tasks ? st.tasks.slice() : [];
        copy.metaLabel = scheduleStageMetaLabel(st, startDate);
        if (startDate) {
            copy.dateStart = formatScheduleDate(addScheduleCalendarDays(startDate, st.startDay - 1));
            copy.dateEnd = formatScheduleDate(addScheduleCalendarDays(startDate, st.endDay - 1));
        } else {
            copy.dateStart = null;
            copy.dateEnd = null;
        }
        return copy;
    });
    return Object.assign({}, scheduleData, {
        stages: stages,
        scheduleStartDate: iso,
        scheduleDateStart: startDate ? formatScheduleDate(startDate) : null,
        scheduleDateEnd: (startDate && scheduleData.totalDays)
            ? formatScheduleDate(addScheduleCalendarDays(startDate, scheduleData.totalDays - 1))
            : null
    });
}

function buildScheduleTimelineHtml(scheduleData) {
    let html = '<div class="v2-timeline sprav-schedule-timeline" role="list">';
    scheduleData.stages.forEach(function (st, i) {
        const col = scheduleRingBarColor(st, i);
        const meta = st.metaLabel || scheduleStageMetaLabel(st, null);
        html += '<div class="v2-item" role="listitem">';
        html += '<div class="v2-dot" style="background:' + col + ';box-shadow:0 0 0 2px ' + col + '"></div>';
        html += '<div class="v2-title">' + st.num + '. ' + escapeHtmlText(st.name) + '</div>';
        html += '<div class="v2-meta">' + escapeHtmlText(meta) + '</div>';
        if (st.tasks && st.tasks.length) {
            html += '<ul class="v2-tasks">';
            st.tasks.forEach(function (task) {
                const tip = (task.formula ? task.formula + ' → ' : '') + task.hours + ' ч';
                html += '<li title="' + escapeHtmlText(tip) + '">';
                html += escapeHtmlText(task.name);
                html += ' <span class="v2-task-hrs">' + task.hours + ' ч</span>';
                html += '</li>';
            });
            html += '</ul>';
        }
        html += '</div>';
    });
    html += '</div>';
    return html;
}

function scheduleClipboardHeading(address) {
    const a = String(address || '').trim();
    if (a) return 'График работ — ' + a;
    return 'График работ';
}

/** Текст вертикальной ленты этапов для буфера обмена (как на экране). options.uppercaseStages — названия этапов ЗАГЛАВНЫМИ (для MAX :share). */
function buildScheduleClipboardTimelineText(scheduleData, address, options) {
    if (!scheduleData || !scheduleData.stages || !scheduleData.stages.length) return '';
    options = options || {};
    const uppercaseStages = !!options.uppercaseStages;
    const lines = [];
    lines.push(scheduleClipboardHeading(address));
    lines.push('');
    lines.push('График работ — ' + scheduleData.totalHours + ' ч, ' + scheduleData.totalDays + ' календ. дн. (1 раб. день = ' + scheduleData.hDay + ' ч)');
    lines.push('');
    scheduleData.stages.forEach(function (st) {
        const meta = st.metaLabel || scheduleStageMetaLabel(st, null);
        const title = st.num + '. ' + (st.name || '');
        lines.push(uppercaseStages ? title.toLocaleUpperCase('ru-RU') : title);
        lines.push(meta);
        (st.tasks || []).forEach(function (task) {
            let row = '  — ' + (task.name || '');
            if (task.hours) row += ' — ' + task.hours + ' ч';
            if (task.formula) row += ' (' + task.formula + ')';
            lines.push(row);
        });
        lines.push('');
    });
    return lines.join('\r\n').replace(/\r\n$/, '');
}

/** HTML ленты этапов для буфера (названия этапов — жирным). */
function buildScheduleClipboardTimelineHtml(scheduleData, address) {
    if (!scheduleData || !scheduleData.stages || !scheduleData.stages.length) return '';
    const heading = scheduleClipboardHeading(address);
    let html = '<div>';
    html += '<p><strong>' + escapeHtmlText(heading) + '</strong></p>';
    html += '<p>' + escapeHtmlText('График работ — ' + scheduleData.totalHours + ' ч, ' + scheduleData.totalDays + ' календ. дн. (1 раб. день = ' + scheduleData.hDay + ' ч)') + '</p>';
    scheduleData.stages.forEach(function (st) {
        const meta = st.metaLabel || scheduleStageMetaLabel(st, null);
        html += '<p><strong>' + escapeHtmlText(st.num + '. ' + (st.name || '')) + '</strong></p>';
        html += '<p>' + escapeHtmlText(meta) + '</p>';
        (st.tasks || []).forEach(function (task) {
            let row = (task.name || '');
            if (task.hours) row += ' — ' + task.hours + ' ч';
            if (task.formula) row += ' (' + task.formula + ')';
            html += '<p style="margin:0 0 0.35em 1.25em;">— ' + escapeHtmlText(row) + '</p>';
        });
        html += '<p></p>';
    });
    html += '</div>';
    return html;
}

function buildScheduleHtml(scheduleData) {
    if (!scheduleData || !scheduleData.stages || !scheduleData.stages.length) {
        return '';
    }
    const v = scheduleData.variables || {};
    let html = '<div class="sprav-schedule-wrap">';
    html += '<div class="sprav-schedule-summary">';
    html += '<strong>График работ</strong> — ';
    html += scheduleData.totalHours + ' ч, ';
    html += scheduleData.totalDays + ' календ. дн. ';
    html += '<span class="sprav-schedule-summary-muted">(1 раб. день = ' + scheduleData.hDay + ' ч)</span>';
    if (scheduleData.scheduleDateStart && scheduleData.scheduleDateEnd) {
        html += ' <span class="sprav-schedule-summary-muted">· ' + escapeHtmlText(scheduleData.scheduleDateStart) + ' — ' + escapeHtmlText(scheduleData.scheduleDateEnd) + '</span>';
    }
    html += '</div>';
    html += '<div class="sprav-schedule-vars" title="Площади и количества для формул">';
    html += 'S стен ' + (v.wallArea || 0).toFixed(1) + ' м² · S пола ' + (v.laminateArea || 0).toFixed(1) + ' м² · S плитки ' + (v.tileArea || 0).toFixed(1) + ' м² · S потолка ' + (v.ceilingArea || 0).toFixed(1) + ' м²';
    if (v.hasElectrical) html += ' · электр. ' + v.electricalPoints + ' т.';
    if (v.hasPlumbing) html += ' · сантех. ' + v.plumbingItems + ' ед.';
    html += '</div>';
    html += '<div class="sprav-schedule-date-bar">';
    html += '<label class="sprav-schedule-date-label" for="spravScheduleStartDate">Дата начала работ</label>';
    html += '<input type="date" class="sprav-schedule-date-input" id="spravScheduleStartDate" value="' + escapeHtmlText(scheduleData.scheduleStartDate || '') + '">';
    html += '</div>';
    html += '<div class="sprav-schedule-chart-toolbar">';
    html += '<div class="sprav-schedule-chart-toggle" role="tablist" aria-label="Вид графика">';
    html += '<button type="button" class="sprav-schedule-chart-btn sprav-schedule-chart-btn--on" data-schedule-view="heat" role="tab" aria-selected="true">Тепловая шкала</button>';
    html += '<button type="button" class="sprav-schedule-chart-btn" data-schedule-view="ring" role="tab" aria-selected="false">Кольцевая диаграмма</button>';
    html += '</div>';
    html += '<button type="button" class="sprav-schedule-chart-dl-btn" data-schedule-download-current title="Скачать тепловую шкалу (PNG)">Скачать</button>';
    html += '</div>';
    html += '<div class="sprav-schedule-chart-panels">';
    html += '<div class="sprav-schedule-chart-panel" data-schedule-panel="heat" role="tabpanel">';
    html += buildScheduleHeatChartHtml(scheduleData);
    html += '</div>';
    html += '<div class="sprav-schedule-chart-panel" data-schedule-panel="ring" role="tabpanel" hidden>';
    html += buildScheduleRingChartHtml(scheduleData);
    html += '</div>';
    html += '</div>';
    html += '<div class="sprav-schedule-timeline-block">';
    html += '<div class="sprav-schedule-timeline-head">';
    html += '<h4 class="sprav-schedule-timeline-heading">Последовательность этапов</h4>';
    html += '<button type="button" class="sprav-schedule-chart-dl-btn" data-schedule-copy title="Скопировать текст ленты этапов в буфер обмена">Скопировать</button>';
    html += '</div>';
    html += buildScheduleTimelineHtml(scheduleData);
    html += '</div></div>';
    return html;
}

function exportScheduleToExcel(calc, address) {
    const scheduleData = buildScheduleData(calc);
    if (!scheduleData || !scheduleData.stages || !scheduleData.stages.length) {
        return false;
    }
    const title = scheduleClipboardHeading(address);
    const rawAddr = address != null ? String(address).trim() : '';
    const downloadFilename = excelExportFilenameStem('grafik_etapov', rawAddr);
    let htmlContent = `
            <!DOCTYPE html>
            <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
            <head>
                <meta charset="UTF-8">
                <style>
                    table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: top; }
                    th { background-color: #4472C4; color: white; font-weight: bold; text-align: center; }
                    .stage-row { background-color: #E7F0FD; font-weight: bold; color: #2F5597; }
                    .number { text-align: right; }
                </style>
            </head>
            <body>
                <h2 style="text-align: center; color: #2F5597;">${escapeHtmlText(title)}</h2>
                <p style="text-align: center; color: #666;">${escapeHtmlText('График работ — ' + scheduleData.totalHours + ' ч, ' + scheduleData.totalDays + ' календ. дн. (1 раб. день = ' + scheduleData.hDay + ' ч)')}</p>
                <table>
                    <thead>
                        <tr>
                            <th style="width: 5%;">№</th>
                            <th style="width: 25%;">Этап</th>
                            <th style="width: 20%;">Срок</th>
                            <th style="width: 42%;">Подработа</th>
                            <th style="width: 8%;">Часы</th>
                        </tr>
                    </thead>
                    <tbody>
        `;
    scheduleData.stages.forEach(function (st) {
        const meta = st.metaLabel || scheduleStageMetaLabel(st, null);
        const tasks = (st.tasks && st.tasks.length) ? st.tasks : [{ name: '—', hours: '', formula: '' }];
        tasks.forEach(function (task, taskIdx) {
            htmlContent += '<tr' + (taskIdx === 0 ? ' class="stage-row"' : '') + '>';
            if (taskIdx === 0) {
                htmlContent += '<td class="number">' + escapeHtmlText(String(st.num)) + '</td>';
                htmlContent += '<td>' + escapeHtmlText(st.name || '') + '</td>';
                htmlContent += '<td>' + escapeHtmlText(meta) + '</td>';
            } else {
                htmlContent += '<td></td><td></td><td></td>';
            }
            htmlContent += '<td>' + escapeHtmlText(task.name || '') + '</td>';
            htmlContent += task.hours ? estimateExcelNumericCellHtml(task.hours) : '<td class="number"></td>';
            htmlContent += '</tr>';
        });
    });
    htmlContent += `
                    </tbody>
                </table>
            </body>
            </html>
        `;
    downloadExcelHtmlFile(htmlContent, downloadFilename);
    return true;
}

global.CmetShared = {
    selectedMaterials: selectedMaterials,
    parseAreaStringToSqm: parseAreaStringToSqm,
    clearSpravSelectedMaterials: clearSpravSelectedMaterials,
    mergePlanOutputOverridesIntoCalc: mergePlanOutputOverridesIntoCalc,
    applyCheckedSubtopics: applyCheckedSubtopics,
    generateDetailedEstimateData: generateDetailedEstimateData,
    buildEstimateTableHtml: buildEstimateTableHtml,
    ensureEstimateTableLiveEditors: ensureEstimateTableLiveEditors,
    refreshEstimateTotalsForTable: refreshEstimateTotalsForTable,
    getEstimateRatePercent: getEstimateRatePercent,
    setEstimateRatePercent: setEstimateRatePercent,
    applyEstimateRatePercentToTable: applyEstimateRatePercentToTable,
    refreshEstimateWithRatePercent: refreshEstimateWithRatePercent,
    ensureEstimateAdjustmentControls: ensureEstimateAdjustmentControls,
    applyEstimateDomEdits: applyEstimateDomEdits,
    collectEstimateFromMirror: collectEstimateFromMirror,
    getBasketProducts: getBasketProducts,
    getBasketUrl: getBasketUrl,
    getBasketUrlForStageRange: getBasketUrlForStageRange,
    buildBasketStageRangePanelHtml: buildBasketStageRangePanelHtml,
    buildScheduleTimelinePanelHtml: buildScheduleTimelinePanelHtml,
    lemanaBasketProductParamFromSku: lemanaBasketProductParamFromSku,
    exportEstimateToExcel: exportEstimateToExcel,
    exportScheduleToExcel: exportScheduleToExcel,
    exportMaterialsLinksToExcel: exportMaterialsLinksToExcel,
    buildMaterialsListHtml: buildMaterialsListHtml,
    spravCalculateEstimate: spravCalculateEstimate,
    buildScheduleData: buildScheduleData,
    applyScheduleStartDate: applyScheduleStartDate,
    buildScheduleHtml: buildScheduleHtml,
    buildScheduleClipboardTimelineText: buildScheduleClipboardTimelineText,
    buildScheduleClipboardTimelineHtml: buildScheduleClipboardTimelineHtml,
    downloadScheduleChartPng: downloadScheduleChartPng
};
})(window);