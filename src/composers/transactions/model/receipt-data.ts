export interface ReceiptData {
    receipt: string;
    date: string;  // Formato "dd/mm/yyyy"
    hour: string; // Formato "hh:mm AM/PM"
    isoDate: string; // Formato ISO 8601 YYYY-MM-DDTHH:MM:SS.000Z
    amount: string; // Número con punto decimal como separador
    currency: string; // Ejemplo: "PEN"
    card: string; // Últimos 4 dígitos de la tarjeta
    description: string; // Breve descripción de la compra
    notes: string; // Notas adicionales
    imageName: string; // Nombre de la imagen de la boleta
}