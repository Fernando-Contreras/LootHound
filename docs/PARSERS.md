# Cómo se leen los estados de cuenta

Los dos parsers están escritos contra el formato **real** de cada banco, no
contra un formato genérico. Se verificaron contra un estado de cuenta completo
de cada uno y ambos cuadran al centavo con los totales que el propio PDF
declara.

---

## El problema de fondo

`pdf.js` no entrega renglones: entrega fragmentos de texto sueltos, cada uno con
su matriz de posición. Reconstruir la tabla es el 80% del trabajo.

[`js/parsers/lines.js`](../js/parsers/lines.js) agrupa esos fragmentos en
líneas:

1. Ordena por Y, luego por X.
2. Agrupa en la misma línea todo lo que caiga dentro de **3 puntos** de
   diferencia vertical.
3. Dentro de la línea, ordena por X e inserta un espacio cuando el hueco
   horizontal supera 0.8 puntos.

**El paso 2 no es opcional.** Nu coloca la fecha y la descripción del mismo
movimiento con 1–2 puntos de diferencia en Y:

```
y=412.0   [136] Depósito en Cajita: Cajita Turbo
y=413.0   [56] 30  [72] JUL  [91] 2026            [497] -$602.97
```

Con agrupación por Y exacta, cada movimiento se parte en dos líneas y no parsea
nada.

---

## BBVA — tarjeta de crédito

### Estructura

```
Periodo: 13-jul-2026 al 12-ago-2026

COMPRAS Y CARGOS DIFERIDOS A MESES SIN INTERESES     ← informativa
29-jun-2026 OMNIBUS DE MEXICO $900.00 $300.00 ...

CARGOS,COMPRAS Y ABONOS REGULARES(NO A MESES)        ← la buena
13-jul-2026 13-jul-2026 CLIP MX*REST ZONG SHEN     + $160.00
16-jul-2026 17-jul-2026 MCDONALD S F36212          + $206.67
USD $11.79 TIPO DE CAMBIO $17.53                     ← hijo del anterior
30-jul-2026 30-jul-2026 BMOVIL.PAGO TDC            - $3,900.00
IVA :$ 0.00 Interes: $ 0.00 Comisiones:$0.00 ...     ← se ignora
22-jul-2026 22-jul-2026 ANTHROPIC* CLAUDE SUB ; Tarjeta Digital ***6202 + $349.69

TOTAL CARGOS  $12,345.67
TOTAL ABONOS -$4,000.00
```

### Regla de extracción

```
^(fecha)\s+(fecha)\s+(descripción)\s+([+-])\s*\$([monto])$
```

### Decisiones tomadas

| Situación | Qué hace el parser | Por qué |
|---|---|---|
| Dos fechas por renglón | usa la **de operación** como fecha del movimiento; guarda la de cargo en `posted_on` | es cuando realmente gastaste |
| `+` | `expense` | en una tarjeta de crédito, un cargo es un gasto |
| `-` con "BMOVIL", "PAGO TDC", "SPEI"… | `transfer` | pagar la tarjeta mueve dinero entre tus cuentas, no es ingreso |
| `-` sin esas palabras | `income` | es una devolución o bonificación |
| Sección "MESES SIN INTERESES" | **se ignora** | su mensualidad ya viene desglosada abajo como "02 DE 03 …"; importar ambas duplicaría el gasto |
| `USD $x TIPO DE CAMBIO $y` | se pega al movimiento anterior | puede quedar en la **página siguiente** a su movimiento, así que el estado se arrastra entre páginas |
| `; Tarjeta Digital ***6202` | se separa a `card_last4` | ensucia la descripción y rompe las reglas de categoría |
| `IVA :$ … Capital:$…` | se ignora | es el desglose del pago, no un movimiento |

### Verificado contra un estado de cuenta real

```
72 movimientos
cargos:  $12,345.67  =  TOTAL CARGOS del PDF   ✓
abonos:  $4,000.00  =  TOTAL ABONOS del PDF   ✓
62 movimientos con tipo de cambio USD
```

---

## Nu — cuenta de débito

### Estructura

```
Saldo inicial                              $10,000.00
Depósitos                                       +$0.00
Gastos                                      -$1,500.00
Dinero generado este mes                      $200.00
Saldo al generar este estado de cuenta     $8,700.00

Detalle de movimientos en tu cuenta                    ← la buena
30 JUL 2026 FANDANGO * Compra                 -$600.00
USD 1.00 = MXN 17.5133 USD 51.22                       ← hijo del anterior
30 JUL 2026 Retiro de Cajita: Cajita Turbo  +$1,500.00

Detalle de movimientos de tus cajitas                  ← espejo, se ignora
```

### Regla de extracción

```
^(dd)\s+(MES)\s+(yyyy)\s+(descripción)\s+([+-])\$([monto])$
```

### Decisiones tomadas

| Situación | Qué hace el parser | Por qué |
|---|---|---|
| `-$` | `expense` | en débito, sale dinero |
| `+$` | `income` | entra dinero |
| "Depósito en Cajita" / "Retiro de Cajita" | `transfer` | son movimientos internos de ahorro. **Nu mismo los excluye** de su total de "Gastos" |
| Sección "movimientos de tus cajitas" | **se ignora** | es el espejo exacto de esos movimientos internos; importarla los duplicaría |
| "Dinero generado este mes" | se ofrece como ingreso **opcional**, desmarcado | no aparece como movimiento pero sí mueve el saldo final |
| `FANDANGO * Compra` | → `FANDANGO` | Nu le pega " Compra" al nombre del comercio |

### La comprobación que prueba que las Cajitas son internas

```
600.00 + 17.50 + 16.62 + 865.88  =  1,500.00  =  "Gastos" del PDF
```

Ninguna Cajita entra en esa suma. Y el saldo cierra:

```
10,000.00 (inicial) + 0 (depósitos) + 200.00 (rendimientos) − 1,500.00 (gastos)
= 8,700.00  =  saldo final declarado   ✓
```

---

## Validación automática

Cada parser compara lo que sumó contra los totales impresos en el PDF y muestra
el resultado en el preview **antes** de importar:

```
✓ Los totales cuadran con los que declara el PDF
              SEGÚN EL PDF    SEGÚN EL PARSER
Cargos         $12,345.67        $12,345.67
Abonos         $4,000.00        $4,000.00
```

Si no cuadran, sale una advertencia en amarillo con la diferencia exacta. Es la
red de seguridad para cuando un banco cambie el formato: en vez de importar
datos mal en silencio, avisa.

---

## Duplicados

Tres capas ([`js/dedupe.js`](../js/dedupe.js)):

**1. Huella exacta** — `UNIQUE(user_id, fingerprint)` en la base.

```
account_id | fecha | monto | tipo | descripción normalizada | repetición
```

El campo *repetición* resuelve un conflicto real: si un estado de cuenta trae
dos renglones idénticos (dos cafés iguales el mismo día — pasa), el primero
lleva `#0` y el segundo `#1`, así que **ambos entran**. Al reimportar el mismo
PDF se vuelven a calcular `#0` y `#1`, y los dos chocan contra la restricción.

Sin ese contador habría que elegir entre perder movimientos reales o permitir
reimportar el mismo estado de cuenta.

**1b. Coincidencia floja, uno a uno** — también cuenta como "ya registrado".

La huella incluye el *tipo* y el *texto*, y los dos pueden cambiar entre una
importación y otra: corriges el tipo en el preview, o se mejora el parser y limpia
un pedazo de texto (ya pasó: BBVA débito dejaba pegada la fecha de liquidación).
Con sólo la huella, el mismo movimiento reimportado entraba duplicado si alguien
usaba "Marcar todo".

Así que además se busca, entre lo guardado, un movimiento de la **misma cuenta,
misma fecha y mismo monto** con descripción casi idéntica (Dice ≥ 0.9). Es *uno a
uno*: cada movimiento guardado cubre a un solo nuevo, así que dos cafés idénticos
siguen siendo dos. Lo que sale marcado "ya registrado" **no se puede volver a
seleccionar** (el checkbox está deshabilitado y "Marcar todo" lo salta), y al
confirmar se vuelve a comprobar contra la base.

**2. Parecido** — aviso suave, no bloquea.

Mismo monto exacto, fecha dentro de ±3 días, y descripción con coeficiente de
Dice ≥ 0.6 sobre bigramas. Sirve para estados de cuenta que se traslapan cuando
el banco escribió el comercio distinto entre una versión y otra.

---

## Qué es tuyo y qué es de otra persona

[`js/parsers/identity.js`](../js/parsers/identity.js) decide si un movimiento es
gasto, ingreso o traspaso. Reglas, en orden:

1. Cajita, retiro de efectivo y pago de tu tarjeta → traspaso, siempre.
2. **Tu nombre** en la descripción → traspaso. Se exigen *todas* las palabras de
   tu nombre (el último apellido puede venir cortado): un hermano con tus mismos
   apellidos NO eres tú. Los apodos ("JuanFer Nu") se registran en *Reglas → Tus
   nombres*.
3. Envío a una plataforma de inversión (GBM, eToro, Bitso...) → traspaso.
4. Mencionar tu otra cartera ("Mercado Pago", "Nu") **sin tu nombre** → traspaso
   marcado *revisar*, porque el nombre del banco no dice de quién es la cuenta. Si
   BBVA imprimió el nombre de la contraparte y no es el tuyo, es otra persona y
   esta regla no aplica. Se confirma solo cuando su pareja (mismo monto, ±3 días)
   ya está en otra cuenta.
5. Compensaciones, bonificaciones y reembolsos del banco → ingreso.
6. Lo demás: entró = ingreso, salió = gasto.

---

## Cuando un banco cambie el formato

1. Abre `tools/parser-lab.html` (sírvelo desde el servidor local, no con
   `file://`).
2. Carga el PDF nuevo y marca **Mostrar todas las líneas extraídas**.
3. Compara las líneas contra las expresiones regulares del parser
   correspondiente.
4. Ajusta, y agrega un caso al fixture sintético en `tests/fixtures/`.
5. `node tests/run.mjs`

Nunca metas un estado de cuenta real a `tests/fixtures/` — el repo es público.
Los fixtures son inventados, con el mismo formato pero datos falsos.

---

## Agregar otro banco

1. Crea `js/parsers/mibanco.js` exportando `BANK_ID`, `BANK_LABEL`,
   `detect(lines)` y `parse(lines)`.
2. Regístralo en el arreglo `PARSERS` de
   [`js/parsers/index.js`](../js/parsers/index.js).
3. Agrega `'mibanco'` al `check` de la columna `bank` en
   `supabase/01_schema.sql` (tablas `accounts` e `imports`).
4. Crea un fixture sintético y su prueba.
