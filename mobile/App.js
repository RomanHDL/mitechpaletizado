import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, StatusBar } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import OperatorScreen from './src/screens/OperatorScreen';
import HomeScreen from './src/screens/HomeScreen';
import ScanScreen from './src/screens/ScanScreen';
import PalletFormScreen from './src/screens/PalletFormScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import { getOperator } from './src/storage';
import { getOperatorTurno } from './src/config';
import { C } from './src/theme';

const Stack = createNativeStackNavigator();

export default function App() {
  const [ready, setReady] = useState(false);
  const [initRoute, setInitRoute] = useState('Operator');
  const [initParams, setInitParams] = useState({});

  useEffect(() => {
    (async () => {
      const stored = await getOperator();
      if (stored) {
        setInitRoute('Home');
        setInitParams({ operator: stored, turno: getOperatorTurno(stored) });
      }
      setReady(true);
    })();
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' }}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <ActivityIndicator color={C.blue} size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer
      theme={{
        dark: true,
        colors: {
          primary: C.blue,
          background: C.bg,
          card: C.bg,
          text: C.text,
          border: C.border,
          notification: C.red,
        },
        fonts: {
          regular: { fontFamily: 'System', fontWeight: '400' },
          medium: { fontFamily: 'System', fontWeight: '500' },
          bold: { fontFamily: 'System', fontWeight: '700' },
          heavy: { fontFamily: 'System', fontWeight: '900' },
        },
      }}
    >
      <Stack.Navigator
        initialRouteName={initRoute}
        screenOptions={{ headerShown: false, animation: 'fade_from_bottom' }}
      >
        <Stack.Screen name="Operator" component={OperatorScreen} />
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          initialParams={initParams}
        />
        <Stack.Screen
          name="Scan"
          component={ScanScreen}
          options={{ animation: 'slide_from_bottom' }}
        />
        <Stack.Screen
          name="PalletForm"
          component={PalletFormScreen}
          options={{ animation: 'slide_from_bottom' }}
        />
        <Stack.Screen
          name="History"
          component={HistoryScreen}
          options={{ animation: 'slide_from_right' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
