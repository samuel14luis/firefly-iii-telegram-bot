import Debug from 'debug'
import OpenAI from "openai";
import { ChatCompletion } from 'openai/resources';

const debug = Debug('openai')

const openAiService = new OpenAI({
  apiKey: "sk-proj-XXXXX",
});

export default async function openai(
  userSettings : { openAiApiKey: string }, imageUrl: string): Promise<ChatCompletion.Choice[]> {
  const log = debug.extend('index')
  
  openAiService.apiKey = userSettings.openAiApiKey;

  const prompt = `Tengo esta boleta, ayudame extrayendo la siguiente información con una estructura en json:
    1.- receipt: Numero de boleta electronica.
    2.- date: Fecha en la que se realizó la compra, solo la fecha, no incluyas la hora, formato dia/mes/año.
    3.- hour: Hora en la que se realizó la compra, formato 12 horas con AM o PM. Ejemplo 12:30 PM.
    4.- isoDate: Fecha y hora en formato ISO 8601, ejemplo 2022-01-01T12:30:00.000Z. Agrega el timezone de acuerdo al país de la moneda, ejemplo para perú (PEN) sería 2022-01-01T12:30:00.000-05:00.
    5.- amount: El monto total de la compra, no incluir la divisa, solo el monto con separación de decimales con un punto (internacional).
    6.- currency: Divisa en la que se realizó la compra, en formato internacional, por ejemplo para soles peruanos sería PEN, para dolares sería USD.
    7.- card: Tarjeta con la que se realizó la operación, normalmente no sale el numero completo sino que está ofuscado con varias letras x, por ejemplo XXXXXXXXXXX5555 o con numeros cero 0, ejemplo 0000000005555, solo dame los 4 ultimos numeros.
    8.- description: Breve descripción de las compras que se realizaron, máximo 30 palabras.
    9.- notes: Breve descripción de las compras que se realizaron, máximo 60 palabras.
    El archivo json final debería tener la siguiente estructura:
    {
      "receipt": "XXXXXX",
      "date": "dd/mm/yyyy",
      "hour": "hh:mm AM/PM",
      "isoDate": "YYYY-MM-DDTHH:MM:SS.000Z",
      "amount": "XXXXXX.XX",
      "currency": "XXX",
      "card": "XXXX",
      "description": "XXXX",
      "notes": "XXXX"
    }
    No agregues saludos ni comentarios, solo devuelve la respuesta en formato JSON exacto.
    `;

  const completion: ChatCompletion = await openAiService.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "user", content: prompt },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  });

  return completion.choices;
}
