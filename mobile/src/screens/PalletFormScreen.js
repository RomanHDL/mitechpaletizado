import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, SafeAreaView, StatusBar,
  TextInput, ScrollView, Alert, ActivityIndicator, Vibration,
  KeyboardAvoidingView, Platform, Modal,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { C, RADIUS, RADIUS_SM } from '../theme';
import {
  CONDITIONS, DESTINATIONS, BARCODE_TYPES,
  DEFAULT_CONDITION, DEFAULT_DESTINO, nowTimestamp,
} from '../config';
import { registerPallet, checkDuplicate } from '../api';
import { getLastDestino, setLastDestino, incrementTodayCount, addRecentPallet } from '../storage';

// ═══════════════════════════════════════════════════════════
// SINGLE-SCREEN PALLET REGISTRATION
//
// Flow: scan pallet (inline camera) → everything auto-fills
//       → edit anything right here → confirm → save
//
// NO separate scan screen. NO modal for SKU. NO summary/edit toggle.
// Everything visible and editable on ONE scrollable screen.
// ═══════════════════════════════════════════════════════════

export default function PalletFormScreen({ navigation, route }) {
  const { palletId: initId, operator, turno, scanned: wasScanned } = route.params;

  const [permission, requestPermission] = useCameraPermissions();

  // ── Phase: scanning pallet or editing form ──
  const [palletId, setPalletId] = useState(initId || '');
  const [palletLocked, setPalletLocked] = useState(!!initId);
  const [showPalletCam, setShowPalletCam] = useState(!initId);

  // ── Form fields (all editable, all visible) ──
  const [items, setItems] = useState([]);
  const [cantidad, setCantidad] = useState('1');
  const [conditions, setConditions] = useState([DEFAULT_CONDITION]);
  const [destino, setDestino] = useState('');
  const [pedido, setPedido] = useState('');
  const [loading, setLoading] = useState(false);

  // ── SKU inline add ──
  const [showSkuCam, setShowSkuCam] = useState(false);
  const [skuInput, setSkuInput] = useState('');
  const [skuQty, setSkuQty] = useState('1');
  const [skuScanned, setSkuScanned] = useState(false);
  const skuLastRef = useRef('');
  const itemIdRef = useRef(1);
  const skuSetRef = useRef(new Set());

  // ── Pallet scan refs ──
  const [palletScanning, setPalletScanning] = useState(false);
  const palletLastRef = useRef('');
  const [torch, setTorch] = useState(false);

  // Auto-fill destino
  useEffect(() => {
    getLastDestino().then((v) => setDestino(v || DEFAULT_DESTINO));
  }, []);

  // Recalculate cantidad when items change
  useEffect(() => {
    if (items.length > 0) {
      const sum = items.reduce((s, i) => s + i.qty, 0);
      setCantidad(String(sum));
    }
  }, [items]);

  // ═══════════════════════════════════════
  // PALLET BARCODE SCANNED (inline camera)
  // ═══════════════════════════════════════
  const onPalletBarcode = useCallback(async ({ data }) => {
    if (palletScanning || data === palletLastRef.current) return;
    setPalletScanning(true);
    palletLastRef.current = data;

    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Vibration.vibrate(80);

    // Check duplicate
    const dup = await checkDuplicate(data);
    if (dup) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Vibration.vibrate([0, 100, 50, 100]);
      Alert.alert(
        'Pallet ya registrado',
        `${data} registrado el ${dup.fecha || '?'} (${dup.turno || '?'}).\n\n¿Registrar de nuevo?`,
        [
          { text: 'Cancelar', style: 'cancel', onPress: () => { setPalletScanning(false); palletLastRef.current = ''; } },
          {
            text: 'Sí, registrar',
            style: 'destructive',
            onPress: () => {
              setPalletId(data);
              setPalletLocked(true);
              setShowPalletCam(false);
              setPalletScanning(false);
              palletLastRef.current = '';
            },
          },
        ],
      );
      return;
    }

    setPalletId(data);
    setPalletLocked(true);
    setShowPalletCam(false);
    setPalletScanning(false);
    palletLastRef.current = '';
  }, [palletScanning]);

  // Manual pallet entry
  const confirmManualPallet = () => {
    const id = palletId.trim();
    if (!id || id.length < 3) {
      Alert.alert('Error', 'ID de pallet muy corto');
      return;
    }
    setPalletLocked(true);
    setShowPalletCam(false);
  };

  // ═══════════════════════════════════════
  // SKU MANAGEMENT
  // ═══════════════════════════════════════
  const isSkuDuplicate = (sku) => {
    const n = String(sku).trim().toUpperCase();
    if (skuSetRef.current.has(n)) return true;
    return items.some((i) => String(i.sku).trim().toUpperCase() === n);
  };

  const addSkuItem = (rawSku, rawQty) => {
    const sku = String(rawSku).trim();
    const q = parseInt(rawQty, 10);
    if (!sku) return false;
    if (!q || q < 1) { Alert.alert('Error', 'Cantidad mínima: 1'); return false; }

    if (isSkuDuplicate(sku)) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Vibration.vibrate([0, 120, 60, 120]);
      Alert.alert('SKU DUPLICADO', `"${sku}" ya está en este pallet.`);
      return false;
    }

    const id = itemIdRef.current++;
    setItems((prev) => [...prev, { id, sku, qty: q }]);
    skuSetRef.current.add(sku.toUpperCase());
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Vibration.vibrate(50);
    return true;
  };

  const removeSku = (id, sku) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setItems((prev) => prev.filter((i) => i.id !== id));
    skuSetRef.current.delete(String(sku).trim().toUpperCase());
  };

  // SKU camera scan
  const onSkuBarcode = ({ data }) => {
    if (skuScanned || data === skuLastRef.current) return;
    setSkuScanned(true);
    skuLastRef.current = data;

    if (isSkuDuplicate(data)) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Vibration.vibrate([0, 120, 60, 120]);
      Alert.alert('SKU DUPLICADO', `"${data}" ya está en este pallet.`,
        [{ text: 'OK', onPress: () => { setSkuScanned(false); skuLastRef.current = ''; } }]);
      return;
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Vibration.vibrate(80);
    setSkuInput(data);
    setShowSkuCam(false);
    setTimeout(() => { setSkuScanned(false); skuLastRef.current = ''; }, 800);
  };

  const confirmAddSku = () => {
    const sku = skuInput.trim();
    if (!sku) { Alert.alert('Error', 'Ingresa un SKU'); return; }
    const q = parseInt(skuQty, 10) || 1;
    if (addSkuItem(sku, q)) {
      setSkuInput('');
      setSkuQty('1');
    }
  };

  // ── Toggles ──
  const toggleCond = (code) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setConditions((prev) => prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]);
  };

  // ═══════════════════════════════════════
  // SUBMIT
  // ═══════════════════════════════════════
  const handleSubmit = async () => {
    const qty = parseInt(cantidad, 10);
    if (!palletId.trim() || palletId.trim().length < 3) {
      Alert.alert('Error', 'Pallet ID inválido'); return;
    }
    if (!qty || qty < 1) {
      Alert.alert('Falta cantidad', 'Ingresa la cantidad'); return;
    }
    if (conditions.length === 0) {
      Alert.alert('Falta condición', 'Selecciona al menos una'); return;
    }
    if (!destino) {
      Alert.alert('Falta destino', 'Selecciona destino'); return;
    }

    setLoading(true);
    try {
      console.log('[SUBMIT] Iniciando registro de pallet:', palletId.trim());

      const result = await registerPallet({
        palletId: palletId.trim(),
        cantidad: qty,
        items,
        condicion: conditions,
        destino,
        turno,
        operador: operator,
        pedido,
      });

      console.log('[SUBMIT] Resultado:', JSON.stringify(result));

      await setLastDestino(destino);

      const newCount = await incrementTodayCount(operator);
      const d = new Date();
      const dayKey = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      await addRecentPallet({
        _day: dayKey,
        id: Date.now(),
        pallet_id: palletId.trim(),
        cantidad: qty,
        destino,
        condicion: conditions.join(', '),
        turno: turno === 'Day' ? 'Day (día)' : 'Night (noche)',
        operator,
        fecha: nowTimestamp(),
        items: items.map((i) => ({ sku: i.sku, cantidad: i.qty })),
      });

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Vibration.vibrate(200);

      // Mensaje detallado de estado de escritura
      const statusParts = [];
      statusParts.push(result.googleSent ? 'Sheet principal ✔' : 'Sheet principal ✘');
      statusParts.push(result.backupSent ? 'Sheet respaldo ✔' : 'Sheet respaldo ✘');
      statusParts.push(result.apiSent ? 'API ✔' : 'API ✘');

      Alert.alert(
        'Registrado',
        `${palletId.trim()} · ${qty} uds · ${destino}\nHoy: ${newCount} pallets\n\n${statusParts.join(' | ')}`,
        [{ text: 'Siguiente', onPress: () => navigation.popToTop() }],
      );
    } catch (err) {
      console.error('[SUBMIT] ❌ Error:', err.message || err);
      Alert.alert(
        'Error al guardar',
        `${err.message || 'No se pudo guardar.'}\n\nRevisa la conexión e intenta de nuevo.`,
      );
    } finally {
      setLoading(false);
    }
  };

  const turnoLabel = turno === 'Day' ? 'Día' : 'Noche';
  const qty = parseInt(cantidad, 10) || 0;

  // ═══════════════════════════════════════════════════
  // RENDER — ONE SINGLE SCREEN
  // ═══════════════════════════════════════════════════

  // Phase 1: Camera to scan pallet barcode
  if (showPalletCam) {
    if (!permission) return <View style={s.safe} />;
    if (!permission.granted) {
      return (
        <SafeAreaView style={s.safe}>
          <StatusBar barStyle="light-content" backgroundColor={C.bg} />
          <View style={s.center}>
            <Ionicons name="camera" size={64} color={C.textMuted} />
            <Text style={s.permTitle}>Cámara necesaria</Text>
            <Text style={s.permSub}>Para escanear códigos de barras</Text>
            <TouchableOpacity style={s.permBtn} onPress={requestPermission}>
              <Text style={s.permBtnTxt}>Permitir cámara</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }

    return (
      <View style={s.safe}>
        <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
          onBarcodeScanned={palletScanning ? undefined : onPalletBarcode}
        />
        <View style={StyleSheet.absoluteFillObject}>
          <SafeAreaView>
            <View style={s.camTopBar}>
              <TouchableOpacity style={s.camTopBtn} onPress={() => navigation.goBack()}>
                <Ionicons name="arrow-back" size={22} color={C.text} />
              </TouchableOpacity>
              <Text style={s.camTopTitle}>Escanear pallet</Text>
              <TouchableOpacity style={s.camTopBtn} onPress={() => setTorch((t) => !t)}>
                <Ionicons name={torch ? 'flash' : 'flash-outline'} size={22} color={torch ? C.yellow : C.text} />
              </TouchableOpacity>
            </View>
          </SafeAreaView>

          <View style={s.frameWrap}>
            <View style={s.frame}>
              <View style={[s.corner, s.cTL]} />
              <View style={[s.corner, s.cTR]} />
              <View style={[s.corner, s.cBL]} />
              <View style={[s.corner, s.cBR]} />
            </View>
            <Text style={s.camHint}>
              {palletScanning ? 'Verificando...' : 'Apunta al código de barras del pallet'}
            </Text>
          </View>

          <SafeAreaView>
            <View style={s.camBottom}>
              <TouchableOpacity style={s.camManualBtn} onPress={() => setShowPalletCam(false)}>
                <Ionicons name="keypad" size={20} color={C.text} />
                <Text style={s.camManualTxt}>Ingresar ID manualmente</Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </View>
      </View>
    );
  }

  // Phase 2: Single editable form — everything visible, everything editable
  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
          <Ionicons name="close" size={24} color={C.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Registro de pallet</Text>
        <View style={{ width: 40 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">

          {/* ── PALLET ID ── */}
          <View style={s.section}>
            <Text style={s.label}>PALLET ID</Text>
            {palletLocked ? (
              <TouchableOpacity style={s.palletBadge} onPress={() => { setPalletLocked(false); }}>
                <Ionicons name="scan" size={16} color={C.green} />
                <Text style={s.palletBadgeTxt}>{palletId}</Text>
                <Ionicons name="create-outline" size={14} color={C.textMuted} />
              </TouchableOpacity>
            ) : (
              <View style={s.palletInputRow}>
                <TextInput
                  style={[s.input, { flex: 1 }]}
                  value={palletId}
                  onChangeText={setPalletId}
                  placeholder="ID del pallet"
                  placeholderTextColor={C.textMuted}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={confirmManualPallet}
                />
                <TouchableOpacity style={s.palletConfirmBtn} onPress={confirmManualPallet}>
                  <Ionicons name="checkmark" size={22} color="#FFF" />
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* ── SKU / CONTENIDO ── */}
          <View style={s.section}>
            <Text style={s.label}>CONTENIDO (SKUs)</Text>

            {items.length > 0 && (
              <View style={s.skuList}>
                {items.map((i) => (
                  <View key={i.id} style={s.skuRow}>
                    <Text style={s.skuCode}>{i.sku}</Text>
                    <Text style={s.skuQtyTxt}>×{i.qty}</Text>
                    <TouchableOpacity onPress={() => removeSku(i.id, i.sku)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Ionicons name="close-circle" size={20} color={C.red} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {/* Inline SKU add */}
            <View style={s.skuAddRow}>
              <TextInput
                style={[s.input, { flex: 1 }]}
                value={skuInput}
                onChangeText={setSkuInput}
                placeholder="Código SKU"
                placeholderTextColor={C.textMuted}
                returnKeyType="done"
                onSubmitEditing={confirmAddSku}
              />
              <TextInput
                style={[s.input, s.skuQtyInput]}
                value={skuQty}
                onChangeText={setSkuQty}
                placeholder="Qty"
                placeholderTextColor={C.textMuted}
                keyboardType="number-pad"
                textAlign="center"
              />
              <TouchableOpacity style={s.skuAddBtn} onPress={confirmAddSku}>
                <Ionicons name="add" size={22} color="#FFF" />
              </TouchableOpacity>
            </View>

            {/* Scan SKU with camera */}
            <TouchableOpacity style={s.skuScanLink} onPress={() => setShowSkuCam(true)}>
              <Ionicons name="scan-outline" size={16} color={C.blue} />
              <Text style={s.skuScanTxt}>Escanear SKU con cámara</Text>
            </TouchableOpacity>
          </View>

          {/* ── CANTIDAD ── */}
          <View style={s.section}>
            <Text style={s.label}>CANTIDAD</Text>
            <View style={s.qtyRow}>
              <TouchableOpacity style={s.qtyBtn} onPress={() => setCantidad(String(Math.max(1, qty - 1)))}>
                <Ionicons name="remove" size={22} color={C.text} />
              </TouchableOpacity>
              <TextInput
                style={s.qtyInput}
                value={cantidad}
                onChangeText={setCantidad}
                keyboardType="number-pad"
                textAlign="center"
              />
              <TouchableOpacity style={s.qtyBtn} onPress={() => setCantidad(String(qty + 1))}>
                <Ionicons name="add" size={22} color={C.text} />
              </TouchableOpacity>
            </View>
          </View>

          {/* ── CONDICIÓN ── */}
          <View style={s.section}>
            <Text style={s.label}>CONDICIÓN</Text>
            <View style={s.chipGrid}>
              {CONDITIONS.map((c) => {
                const active = conditions.includes(c.code);
                return (
                  <TouchableOpacity
                    key={c.code}
                    style={[s.condChip, active && { backgroundColor: c.color, borderColor: c.color }]}
                    onPress={() => toggleCond(c.code)}
                  >
                    <Text style={[s.condTxt, active && { color: '#FFF' }]}>{c.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* ── DESTINO ── */}
          <View style={s.section}>
            <Text style={s.label}>DESTINO</Text>
            <View style={s.destGrid}>
              {DESTINATIONS.map((d) => {
                const active = destino === d.value;
                return (
                  <TouchableOpacity
                    key={d.value}
                    style={[s.destBtn, active && s.destBtnActive]}
                    onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setDestino(d.value); }}
                  >
                    <Ionicons name={d.icon} size={18} color={active ? '#FFF' : C.textMuted} />
                    <Text style={[s.destTxt, active && { color: '#FFF' }]}>{d.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* ── PEDIDO (opcional) ── */}
          <View style={s.section}>
            <Text style={s.label}>PEDIDO (OPCIONAL)</Text>
            <TextInput
              style={s.input}
              value={pedido}
              onChangeText={setPedido}
              placeholder="Número de pedido"
              placeholderTextColor={C.textMuted}
            />
          </View>

          {/* ── INFO AUTO ── */}
          <View style={s.infoBar}>
            <View style={s.infoPill}>
              <Ionicons name="person" size={12} color={C.textSec} />
              <Text style={s.infoTxt}>{operator}</Text>
            </View>
            <View style={s.infoPill}>
              <Ionicons name={turno === 'Day' ? 'sunny' : 'moon'} size={12} color={turno === 'Day' ? C.yellow : C.purple} />
              <Text style={s.infoTxt}>{turnoLabel}</Text>
            </View>
            <View style={s.infoPill}>
              <Ionicons name="calendar" size={12} color={C.textSec} />
              <Text style={s.infoTxt}>Hoy</Text>
            </View>
          </View>

          {/* ── GUARDAR ── */}
          <TouchableOpacity
            style={[s.submitBtn, loading && { opacity: 0.5 }]}
            onPress={handleSubmit}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={24} color="#FFF" />
                <Text style={s.submitTxt}>CONFIRMAR Y GUARDAR</Text>
              </>
            )}
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── SKU Camera Modal (minimal, only for camera) ── */}
      <Modal visible={showSkuCam} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={s.safe}>
          <View style={s.skuCamHeader}>
            <Text style={s.skuCamTitle}>Escanear SKU</Text>
            <TouchableOpacity onPress={() => { setShowSkuCam(false); setSkuScanned(false); skuLastRef.current = ''; }}>
              <Ionicons name="close" size={24} color={C.text} />
            </TouchableOpacity>
          </View>
          <View style={{ flex: 1 }}>
            {permission?.granted ? (
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
                onBarcodeScanned={skuScanned ? undefined : onSkuBarcode}
              />
            ) : (
              <View style={s.center}>
                <Text style={{ color: C.textSec }}>Cámara no disponible</Text>
              </View>
            )}
          </View>
          {items.length > 0 && (
            <View style={s.skuCamFooter}>
              <Text style={s.skuCamFooterTxt}>En pallet: {items.map((i) => `${i.sku}×${i.qty}`).join(', ')}</Text>
            </View>
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

// ═══════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════
const CS = 28;
const CW = 4;

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  permTitle: { color: C.text, fontWeight: '700', fontSize: 20, marginTop: 16 },
  permSub: { color: C.textSec, fontSize: 14, textAlign: 'center', marginTop: 6, marginBottom: 28 },
  permBtn: { backgroundColor: C.blue, borderRadius: RADIUS, paddingHorizontal: 32, paddingVertical: 14 },
  permBtnTxt: { color: '#FFF', fontWeight: '700', fontSize: 16 },

  // ── Camera phase ──
  camTopBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8,
  },
  camTopBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: C.overlay, alignItems: 'center', justifyContent: 'center',
  },
  camTopTitle: { color: C.text, fontWeight: '700', fontSize: 16 },
  frameWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  frame: { width: 280, height: 180, position: 'relative' },
  corner: { position: 'absolute', width: CS, height: CS },
  cTL: { top: 0, left: 0, borderTopWidth: CW, borderLeftWidth: CW, borderColor: C.blue, borderTopLeftRadius: 10 },
  cTR: { top: 0, right: 0, borderTopWidth: CW, borderRightWidth: CW, borderColor: C.blue, borderTopRightRadius: 10 },
  cBL: { bottom: 0, left: 0, borderBottomWidth: CW, borderLeftWidth: CW, borderColor: C.blue, borderBottomLeftRadius: 10 },
  cBR: { bottom: 0, right: 0, borderBottomWidth: CW, borderRightWidth: CW, borderColor: C.blue, borderBottomRightRadius: 10 },
  camHint: {
    color: C.text, fontSize: 14, fontWeight: '500', textAlign: 'center', marginTop: 20,
    backgroundColor: C.overlay, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 20, overflow: 'hidden',
  },
  camBottom: { padding: 20, paddingBottom: 28 },
  camManualBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.overlay, borderRadius: RADIUS, paddingVertical: 14, gap: 8,
    borderWidth: 1, borderColor: C.border,
  },
  camManualTxt: { color: C.text, fontWeight: '600', fontSize: 14 },

  // ── Form phase ──
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: C.text, fontWeight: '700', fontSize: 17, flex: 1, textAlign: 'center' },

  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },

  section: { marginBottom: 18 },
  label: { color: C.textSec, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 },
  input: {
    backgroundColor: C.input, borderWidth: 1, borderColor: C.inputBorder,
    borderRadius: RADIUS, padding: 14, fontSize: 16, color: C.text,
  },

  // Pallet ID
  palletBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(34,197,94,0.1)', borderRadius: RADIUS,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  palletBadgeTxt: { color: C.green, fontWeight: '700', fontSize: 18, flex: 1, letterSpacing: 0.3 },
  palletInputRow: { flexDirection: 'row', gap: 8 },
  palletConfirmBtn: {
    width: 52, borderRadius: RADIUS, backgroundColor: C.blue,
    alignItems: 'center', justifyContent: 'center',
  },

  // SKU section
  skuList: { marginBottom: 10, gap: 6 },
  skuRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.card, borderRadius: RADIUS_SM, padding: 10,
    borderWidth: 1, borderColor: C.border,
  },
  skuCode: { color: C.text, fontWeight: '600', fontSize: 14, flex: 1 },
  skuQtyTxt: { color: C.textSec, fontWeight: '700', fontSize: 14, minWidth: 30, textAlign: 'center' },
  skuAddRow: { flexDirection: 'row', gap: 8 },
  skuQtyInput: { width: 60, textAlign: 'center' },
  skuAddBtn: {
    width: 52, borderRadius: RADIUS, backgroundColor: C.blue,
    alignItems: 'center', justifyContent: 'center',
  },
  skuScanLink: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 10, marginTop: 4,
  },
  skuScanTxt: { color: C.blue, fontWeight: '600', fontSize: 13 },

  // Cantidad
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  qtyBtn: {
    width: 52, height: 52, borderRadius: RADIUS,
    backgroundColor: C.card, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: C.border,
  },
  qtyInput: {
    flex: 1, backgroundColor: C.input, borderWidth: 1, borderColor: C.inputBorder,
    borderRadius: RADIUS, paddingVertical: 12, fontSize: 28, fontWeight: '800', color: C.text,
    textAlign: 'center',
  },

  // Condición
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  condChip: {
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: RADIUS_SM,
    backgroundColor: C.card, borderWidth: 1.5, borderColor: C.border, minWidth: 56, alignItems: 'center',
  },
  condTxt: { fontSize: 13, fontWeight: '700', color: C.textSec },

  // Destino
  destGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  destBtn: {
    flex: 1, minWidth: '44%', paddingVertical: 14, borderRadius: RADIUS,
    backgroundColor: C.card, alignItems: 'center', gap: 4,
    borderWidth: 1.5, borderColor: C.border,
  },
  destBtnActive: { backgroundColor: C.blue, borderColor: C.blue },
  destTxt: { fontSize: 13, fontWeight: '600', color: C.textSec },

  // Info bar
  infoBar: {
    flexDirection: 'row', justifyContent: 'center', gap: 10,
    marginBottom: 16, flexWrap: 'wrap',
  },
  infoPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: C.card, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6,
    borderWidth: 1, borderColor: C.border,
  },
  infoTxt: { color: C.textSec, fontSize: 12, fontWeight: '600' },

  // Submit
  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.green, borderRadius: RADIUS, paddingVertical: 18, gap: 10,
  },
  submitTxt: { color: '#FFF', fontWeight: '800', fontSize: 17, letterSpacing: 0.5 },

  // SKU camera modal (minimal)
  skuCamHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  skuCamTitle: { color: C.text, fontWeight: '700', fontSize: 17 },
  skuCamFooter: {
    padding: 12, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.card,
  },
  skuCamFooterTxt: { color: C.textSec, fontSize: 12, fontWeight: '600', textAlign: 'center' },
});
