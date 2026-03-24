import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, StatusBar, FlatList,
  TouchableOpacity, RefreshControl, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { C, RADIUS, RADIUS_SM } from '../theme';
import { fetchRecent } from '../api';
import { getRecentPallets } from '../storage';

export default function HistoryScreen({ navigation, route }) {
  const operator = route.params?.operator;
  const [pallets, setPallets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    // Primary: local history (always works, filtered by operator + today)
    const local = await getRecentPallets(operator);

    // Secondary: try backend
    let remote = [];
    try {
      remote = await fetchRecent(operator, 100);
    } catch { /* backend may be offline */ }

    // Merge: show local entries first (most reliable), then add any backend
    // entries not already in local (by pallet_id + timestamp dedup)
    const localIds = new Set(local.map((p) => p.pallet_id));
    const merged = [...local];
    for (const r of remote) {
      if (!localIds.has(r.pallet_id)) {
        merged.push(r);
      }
    }

    setPallets(merged);
    setLoading(false);
    setRefreshing(false);
  }, [operator]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const renderItem = ({ item: p }) => {
    const hasItems = p.items && p.items.length > 0;
    return (
      <View style={s.row}>
        <View style={s.rowTop}>
          <Text style={s.palletId}>{p.pallet_id}</Text>
          <View style={s.rowBadge}>
            <Text style={s.rowBadgeTxt}>×{p.cantidad || 0}</Text>
          </View>
        </View>
        <View style={s.rowMeta}>
          <Text style={s.metaVal}>{p.destino || '—'}</Text>
          <Text style={s.metaDot}>·</Text>
          <Text style={s.metaVal}>{p.condicion || '—'}</Text>
          <Text style={s.metaDot}>·</Text>
          <Text style={s.metaVal}>{p.turno || '—'}</Text>
        </View>
        {hasItems && (
          <View style={s.skuRow}>
            {p.items.map((item, i) => (
              <View key={i} style={s.skuChip}>
                <Text style={s.skuTxt}>{item.sku} ×{item.cantidad}</Text>
              </View>
            ))}
          </View>
        )}
        <Text style={s.rowDate}>{p.fecha}</Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={22} color={C.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Historial de hoy</Text>
        <View style={s.countBadge}>
          <Text style={s.countTxt}>{pallets.length}</Text>
        </View>
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={C.blue} size="large" />
        </View>
      ) : pallets.length === 0 ? (
        <View style={s.center}>
          <Ionicons name="cube-outline" size={56} color={C.textMuted} />
          <Text style={s.emptyTxt}>Sin registros hoy</Text>
        </View>
      ) : (
        <FlatList
          data={pallets}
          keyExtractor={(p, i) => `${p.pallet_id}-${p.id || i}`}
          renderItem={renderItem}
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={C.blue} />
          }
          ItemSeparatorComponent={() => <View style={s.sep} />}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.border, gap: 12,
  },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, color: C.text, fontWeight: '700', fontSize: 17 },
  countBadge: {
    backgroundColor: C.blue, borderRadius: 12,
    paddingHorizontal: 10, paddingVertical: 4, minWidth: 32, alignItems: 'center',
  },
  countTxt: { color: '#FFF', fontWeight: '700', fontSize: 13 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyTxt: { color: C.textMuted, fontSize: 14, marginTop: 12 },

  list: { padding: 16 },
  sep: { height: 1, backgroundColor: C.border, marginVertical: 4 },

  row: { paddingVertical: 14, paddingHorizontal: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  palletId: { color: C.text, fontWeight: '700', fontSize: 17, letterSpacing: 0.3 },
  rowBadge: {
    backgroundColor: C.surface, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3,
  },
  rowBadgeTxt: { color: C.textSec, fontWeight: '700', fontSize: 13 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  metaVal: { color: C.textSec, fontSize: 13 },
  metaDot: { color: C.textMuted, fontSize: 13 },
  skuRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  skuChip: {
    backgroundColor: 'rgba(59,130,246,0.1)', borderRadius: 4,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  skuTxt: { color: C.blue, fontSize: 12, fontWeight: '600' },
  rowDate: { color: C.textMuted, fontSize: 11, marginTop: 6 },
});
