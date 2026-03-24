import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar, SafeAreaView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { OPERATORS } from '../config';
import { C, RADIUS } from '../theme';
import { setOperator } from '../storage';

export default function OperatorScreen({ navigation }) {
  const pick = async (op) => {
    await setOperator(op.name);
    navigation.replace('Home', { operator: op.name, turno: op.turno });
  };

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View style={s.wrap}>
        <View style={s.logoRow}>
          <View style={s.logoBox}><Text style={s.logoTxt}>MT</Text></View>
          <Text style={s.logoName}>MI-TECH Paletizado</Text>
        </View>

        <Text style={s.title}>¿Quién escanea?</Text>
        <Text style={s.sub}>Se recordará en este dispositivo</Text>

        <View style={s.list}>
          {OPERATORS.map((op) => (
            <TouchableOpacity key={op.id} style={s.card} activeOpacity={0.6} onPress={() => pick(op)}>
              <View style={s.avatar}>
                <Ionicons name="person" size={22} color={C.blue} />
              </View>
              <Text style={s.name}>{op.name}</Text>
              <Ionicons name="chevron-forward" size={18} color={C.textMuted} />
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  wrap: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  logoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 40, gap: 10 },
  logoBox: { width: 42, height: 42, borderRadius: 10, backgroundColor: C.blue, alignItems: 'center', justifyContent: 'center' },
  logoTxt: { color: '#FFF', fontWeight: '800', fontSize: 16 },
  logoName: { color: C.text, fontWeight: '700', fontSize: 18 },
  title: { color: C.text, fontWeight: '700', fontSize: 22, textAlign: 'center', marginBottom: 4 },
  sub: { color: C.textSec, fontSize: 14, textAlign: 'center', marginBottom: 28 },
  list: { gap: 8 },
  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card, borderRadius: RADIUS,
    padding: 16, borderWidth: 1, borderColor: C.border, gap: 14,
  },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(59,130,246,0.12)', alignItems: 'center', justifyContent: 'center' },
  name: { flex: 1, color: C.text, fontWeight: '600', fontSize: 16 },
});
