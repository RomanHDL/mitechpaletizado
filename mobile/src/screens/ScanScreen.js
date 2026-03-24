import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, SafeAreaView,
  Alert, Vibration, TextInput, Modal, StatusBar,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { C, RADIUS } from '../theme';
import { BARCODE_TYPES } from '../config';
import { checkDuplicate } from '../api';

export default function ScanScreen({ navigation, route }) {
  const { operator, turno } = route.params;
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [torch, setTorch] = useState(false);
  const [manualModal, setManualModal] = useState(false);
  const [manualId, setManualId] = useState('');
  const lastScanRef = useRef('');

  const processId = useCallback(async (palletId) => {
    // Haptic success
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Vibration.vibrate(80);

    // Check duplicate
    const dup = await checkDuplicate(palletId);
    if (dup) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Vibration.vibrate([0, 100, 50, 100]);
      Alert.alert(
        'Pallet ya registrado',
        `${palletId} fue registrado el ${dup.fecha || '?'} (${dup.turno || '?'}).\n\n¿Registrar de nuevo?`,
        [
          { text: 'Cancelar', style: 'cancel', onPress: () => { setScanned(false); lastScanRef.current = ''; } },
          {
            text: 'Registrar igual',
            style: 'destructive',
            onPress: () => {
              navigation.navigate('PalletForm', { palletId, operator, turno, scanned: true });
              setTimeout(() => { setScanned(false); lastScanRef.current = ''; }, 1500);
            },
          },
        ]
      );
      return;
    }

    // Navigate to form
    navigation.navigate('PalletForm', { palletId, operator, turno, scanned: true });
    setTimeout(() => { setScanned(false); lastScanRef.current = ''; }, 1500);
  }, [operator, turno, navigation]);

  const onBarCode = useCallback(({ data }) => {
    if (scanned || data === lastScanRef.current) return;
    setScanned(true);
    lastScanRef.current = data;
    processId(data);
  }, [scanned, processId]);

  const submitManual = () => {
    const id = manualId.trim();
    if (!id || id.length < 4) {
      Alert.alert('Error', 'Ingresa un ID válido (mínimo 4 caracteres)');
      return;
    }
    setManualModal(false);
    setManualId('');
    navigation.navigate('PalletForm', { palletId: id, operator, turno, scanned: false });
  };

  // ── Permission not granted ──
  if (!permission) return <View style={s.bg} />;
  if (!permission.granted) {
    return (
      <SafeAreaView style={s.bg}>
        <StatusBar barStyle="light-content" />
        <View style={s.center}>
          <Ionicons name="camera" size={64} color={C.textMuted} />
          <Text style={s.permTitle}>Cámara necesaria</Text>
          <Text style={s.permSub}>Para escanear códigos de barras de pallets</Text>
          <TouchableOpacity style={s.permBtn} onPress={requestPermission}>
            <Text style={s.permBtnTxt}>Permitir cámara</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.permBack} onPress={() => navigation.goBack()}>
            <Text style={s.permBackTxt}>Volver</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Scanner active ──
  return (
    <View style={s.bg}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />

      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        enableTorch={torch}
        barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
        onBarcodeScanned={scanned ? undefined : onBarCode}
      />

      {/* Overlay */}
      <View style={StyleSheet.absoluteFillObject}>
        {/* Top bar */}
        <SafeAreaView>
          <View style={s.topBar}>
            <TouchableOpacity style={s.topBtn} onPress={() => navigation.goBack()}>
              <Ionicons name="arrow-back" size={22} color={C.text} />
            </TouchableOpacity>
            <Text style={s.topTitle}>Escanear pallet</Text>
            <TouchableOpacity style={s.topBtn} onPress={() => setTorch((t) => !t)}>
              <Ionicons name={torch ? 'flash' : 'flash-outline'} size={22} color={torch ? C.yellow : C.text} />
            </TouchableOpacity>
          </View>
        </SafeAreaView>

        {/* Scan frame */}
        <View style={s.frameWrap}>
          <View style={s.frame}>
            <View style={[s.corner, s.cTL]} />
            <View style={[s.corner, s.cTR]} />
            <View style={[s.corner, s.cBL]} />
            <View style={[s.corner, s.cBR]} />
          </View>
          <Text style={s.hint}>
            {scanned ? 'Verificando...' : 'Apunta al código de barras'}
          </Text>
        </View>

        {/* Bottom */}
        <SafeAreaView>
          <View style={s.bottom}>
            <TouchableOpacity style={s.manualBtn} onPress={() => setManualModal(true)}>
              <Ionicons name="keypad" size={20} color={C.text} />
              <Text style={s.manualTxt}>Ingresar ID manualmente</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </View>

      {/* Manual entry modal */}
      <Modal visible={manualModal} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Ingresar ID del pallet</Text>
            <TextInput
              style={s.modalInput}
              value={manualId}
              onChangeText={setManualId}
              placeholder="ID del pallet"
              placeholderTextColor={C.textMuted}
              keyboardType="default"
              autoFocus
              returnKeyType="done"
              onSubmitEditing={submitManual}
            />
            <View style={s.modalBtns}>
              <TouchableOpacity
                style={s.modalCancel}
                onPress={() => { setManualModal(false); setManualId(''); }}
              >
                <Text style={s.modalCancelTxt}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalOk} onPress={submitManual}>
                <Text style={s.modalOkTxt}>Continuar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const CS = 28;
const CW = 4;

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  permTitle: { color: C.text, fontWeight: '700', fontSize: 20, marginTop: 16 },
  permSub: { color: C.textSec, fontSize: 14, textAlign: 'center', marginTop: 6, marginBottom: 28 },
  permBtn: { backgroundColor: C.blue, borderRadius: RADIUS, paddingHorizontal: 32, paddingVertical: 14 },
  permBtnTxt: { color: '#FFF', fontWeight: '700', fontSize: 16 },
  permBack: { marginTop: 16 },
  permBackTxt: { color: C.textSec, fontSize: 14 },

  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8,
  },
  topBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: C.overlay, alignItems: 'center', justifyContent: 'center',
  },
  topTitle: { color: C.text, fontWeight: '700', fontSize: 16 },

  frameWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  frame: { width: 280, height: 180, position: 'relative' },
  corner: { position: 'absolute', width: CS, height: CS },
  cTL: { top: 0, left: 0, borderTopWidth: CW, borderLeftWidth: CW, borderColor: C.blue, borderTopLeftRadius: 10 },
  cTR: { top: 0, right: 0, borderTopWidth: CW, borderRightWidth: CW, borderColor: C.blue, borderTopRightRadius: 10 },
  cBL: { bottom: 0, left: 0, borderBottomWidth: CW, borderLeftWidth: CW, borderColor: C.blue, borderBottomLeftRadius: 10 },
  cBR: { bottom: 0, right: 0, borderBottomWidth: CW, borderRightWidth: CW, borderColor: C.blue, borderBottomRightRadius: 10 },
  hint: {
    color: C.text, fontSize: 14, fontWeight: '500', textAlign: 'center', marginTop: 20,
    backgroundColor: C.overlay, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 20, overflow: 'hidden',
  },

  bottom: { padding: 20, paddingBottom: 28 },
  manualBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.overlay, borderRadius: RADIUS, paddingVertical: 14, gap: 8,
    borderWidth: 1, borderColor: C.border,
  },
  manualTxt: { color: C.text, fontWeight: '600', fontSize: 14 },

  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: C.card, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 24, paddingBottom: 40,
  },
  modalTitle: { color: C.text, fontWeight: '700', fontSize: 18, marginBottom: 16 },
  modalInput: {
    backgroundColor: C.input, borderWidth: 1, borderColor: C.inputBorder,
    borderRadius: RADIUS, padding: 16, fontSize: 18, color: C.text,
  },
  modalBtns: { flexDirection: 'row', gap: 12, marginTop: 16 },
  modalCancel: {
    flex: 1, paddingVertical: 14, borderRadius: RADIUS,
    backgroundColor: C.surface, alignItems: 'center',
  },
  modalCancelTxt: { color: C.textSec, fontWeight: '600', fontSize: 15 },
  modalOk: {
    flex: 1, paddingVertical: 14, borderRadius: RADIUS,
    backgroundColor: C.blue, alignItems: 'center',
  },
  modalOkTxt: { color: '#FFF', fontWeight: '700', fontSize: 15 },
});
