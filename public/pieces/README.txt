PIEZAS SVG (personalizables)

Cómo cambiar los iconos:
1) Ve a /public/pieces/
2) Reemplaza estos archivos con tus propios SVG (mantén los mismos nombres):
   k.svg q.svg r.svg b.svg n.svg p.svg

Recomendación:
- Usa viewBox="0 0 100 100" (o el que prefieras)
- Dentro del SVG usa fill="currentColor" en tus paths para que el color lo controle el CSS:
   Blancas: .piece.pw { color: ... }
   Negras:  .piece.pb { color: ... }

Opcional (diferente icono por color):
- Puedes crear archivos específicos por color:
   wk.svg wq.svg ...  (blancas)
   bk.svg bq.svg ...  (negras)
Si existen, el juego los prioriza sobre k.svg/q.svg/etc.
