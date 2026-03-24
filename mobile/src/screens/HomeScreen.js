import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar, SafeAreaView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { C, RADIUS } from '../theme';
import { getOperatorTurno } from '../config';
import { clearOperator, getTodayCount } from '../storage';
import { fetchStats } from '../api';

export default function HomeScreen({ navigation, route }) {
  const operator = route.params?.operator || 'Operador';
  const turno = route.params?.turno || getOperatorTurno(operator);
  const turnoLabel = turno === 'Day' ? 'Turno día' : 'Turno noche';
  const turnoIcon = turno === 'Day' ? 'sunny' : 'moon';
  const turnoColor = turno === 'Day' ? C.yellow : C.purple;

  const [todayCount, setTodayCount] = useState(0);
  const [byDestino, setByDestino] = useState([]);

  useFocusEffect(
    useCallback(() => {
      // Primary source: local counter (always works, even offline)
      getTodayCount(operator).then((localCount) => {
        setTodayCount(localCount);
      });

      // Secondary source: backend stats (may fail if server unreachable)
      fetchStats(operator).then((s) => {
        if (s && s.today > 0) {
          // Use the higher of local or backend count
          setTodayCount((prev) => Math.max(prev, s.today));
        }
        if (s && s.byDestino && s.byDestino.length > 0) {
          setByDestino(s.byDestino);
        }
      });
    }, [operator])
  );

  const changeOperator = async () => {
    await clearOperator();
    navigation.replace('Operator');
  };

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* Header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <View style={s.avatarSm}>
            <Ionicons name="person" size={16} color={C.blue} />
          </View>
          <View>
            <Text style={s.operName}>{operator}</Text>
            <View style={s.shiftRow}>
              <Ionicons name={turnoIcon} size={12} color={turnoColor} />
              <Text style={s.shiftTxt}>{turnoLabel}</Text>
            </View>
          </View>
        </View>
        <TouchableOpacity onPress={changeOperator} style={s.changeBtn}>
          <Ionicons name="swap-horizontal" size={20} color={C.textSec} />
        </TouchableOpacity>
      </View>

      {/* Content */}
      <View style={s.body}>
        {/* Today counter */}
        <View style={s.counterCard}>
          <Text style={s.counterNum}>{todayCount}</Text>
          <Text style={s.counterLabel}>pallets registrados hoy</Text>
          {byDestino.length > 0 && (
            <View style={s.destRow}>
              {byDestino.map((d, i) => (
                <View key={i} style={s.destChip}>
                  <Text style={s.destTxt}>{d.destino}: {d.total}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* BIG SCAN BUTTON */}
        <TouchableOpacity
          style={s.scanBtn}
          activeOpacity={0.75}
          onPress={() => navigation.navigate('PalletForm', { operator, turno, palletId: '', scanned: false })}
        >
          <View style={s.scanIconWrap}>
            <Ionicons name="scan" size={48} color="#FFF" />
          </View>
          <Text style={s.scanTitle}>ESCANEAR PALLET</Text>
          <Text style={s.scanSub}>Toca para abrir la cámara</Text>
        </TouchableOpacity>

        {/* Quick actions */}
        <View style={s.actionsRow}>
          <TouchableOpacity
            style={s.actionCard}
            onPress={() => navigation.navigate('PalletForm', { operator, turno, palletId: '', scanned: false })}
          >
            <Ionicons name="keypad" size={24} color={C.blue} />
            <Text style={s.actionTxt}>Registro{'\n'}manual</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={s.actionCard}
            onPress={() => navigation.navigate('History', { operator })}
          >
            <Ionicons name="time" size={24} color={C.green} />
            <Text style={s.actionTxt}>Historial{'\n'}de hoy</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatarSm: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(59,130,246,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  operName: { color: C.text, fontWeight: '700', fontSize: 15 },
  shiftRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
  shiftTxt: { color: C.textSec, fontSize: 12 },
  changeBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: C.card, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: C.border,
  },

  body: { flex: 1, padding: 20, justifyContent: 'center', gap: 20 },

  counterCard: {
    backgroundColor: C.card, borderRadius: RADIUS,
    padding: 20, alignItems: 'center',
    borderWidth: 1, borderColor: C.border,
  },
  counterNum: { color: C.text, fontWeight: '800', fontSize: 48, lineHeight: 56 },
  counterLabel: { color: C.textSec, fontSize: 14, marginTop: 2 },
  destRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12, justifyContent: 'center' },
  destChip: {
    backgroundColor: C.surface, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3,
  },
  destTxt: { color: C.textSec, fontSize: 11, fontWeight: '600' },

  scanBtn: {
    backgroundColor: C.blue, borderRadius: RADIUS + 4, paddingVertical: 32,
    alignItems: 'center', gap: 8,
    shadowColor: C.blue, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4, shadowRadius: 16, elevation: 8,
  },
  scanIconWrap: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  scanTitle: { color: '#FFF', fontWeight: '800', fontSize: 20, letterSpacing: 1 },
  scanSub: { color: 'rgba(255,255,255,0.7)', fontSize: 13 },

  actionsRow: { flexDirection: 'row', gap: 12 },
  actionCard: {
    flex: 1, backgroundColor: C.card, borderRadius: RADIUS,
    padding: 18, alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: C.border,
  },
  actionTxt: { color: C.textSec, fontSize: 12, fontWeight: '600', textAlign: 'center', lineHeight: 16 },
});
