import dayjs from 'dayjs'
import debug from 'debug'
import { Composer, InlineKeyboard } from 'grammy'
import { Router } from "@grammyjs/router"

import type { MyContext } from '../../types/MyContext'
import {
  parseAmountInput,
  formatTransaction,
  createFireflyTransaction,
  cleanupSessionData,
} from '../helpers'

import { transactionRecordMenu, addTransactionMenu } from './add-transactions-menus'


import firefly from '../../lib/firefly'
import { TransactionRead } from '../../lib/firefly/model/transaction-read'
import { TransactionTypeProperty } from '../../lib/firefly/model/transaction-type-property'
import { AccountTypeFilter } from '../../lib/firefly/model/account-type-filter'
import { AccountAttributes } from '../../types/SessionData'
import { CATEGORIES_PAGE_LIMIT, ACCOUNTS_PAGE_LIMIT } from '../constants'
import { handleCallbackQueryError } from '../../lib/errorHandler'
import config from '../../config'
import openai from '../../lib/openai'
import { ChatCompletion } from 'openai/resources'
import { ReceiptData } from './model/receipt-data'

export enum Route {
  SET_FOREIGN_AMOUNT = 'NEW_TRANSACTION|FOREIGN_AMOUNT',
}

const rootLog = debug(`bot:transactions:add`)

const bot = new Composer<MyContext>()
const router = new Router<MyContext>((ctx) => ctx.session.step)

router.route(Route.SET_FOREIGN_AMOUNT, setForeignAmountRouteHandler)

bot.use(transactionRecordMenu)
bot.use(addTransactionMenu)
bot.use(router)

export default bot

export async function addTransactionByImage(ctx: MyContext) {
  const log = rootLog.extend('addTransactionByImage')
  log('Entered image handler')
  try {  
    if (!(ctx.message && ctx.message.photo)) {
      log('No photo... Replying with instruction')
      await ctx.reply(ctx.i18n.t('transactions.add.notFoundImage'), {
        parse_mode: 'Markdown',
      })
      return null
    }
  
    const photos = ctx.message.photo;
    const largestPhoto = photos[photos.length - 1];
    log('ctx.message.image: %O', largestPhoto.file_id)
  
    const file = await ctx.api.getFile(largestPhoto.file_id);
  
    if (!file.file_path) {
      log('No file path... Replying with instruction')
      await ctx.reply(ctx.i18n.t('transactions.add.dontUnderstandImage'), {
        parse_mode: 'Markdown',
      })
      return 
    }

    const buffer: ArrayBuffer = await getBufferFromPhoto(log, file.file_path);
    const openaiResponse: string = await getTransactionFromPhoto(log, file.file_path);
    const transactionDetail: ReceiptData | null = parseOpenAiResponse(openaiResponse);

    if (!transactionDetail) {
      log('No transaction detail... Replying with instruction')
      await ctx.reply(ctx.i18n.t('transactions.add.cantExtractImageData'), {
        parse_mode: 'Markdown',
      })
      return 
    }

    transactionDetail.imageName = `${transactionDetail.date.replace("/", ".").replace("/", ".")}-${transactionDetail.receipt}-TARJ${transactionDetail.card}.png`;
    transactionDetail.notes = `${transactionDetail.notes}

BOLETA ELECTRONICA ${transactionDetail.imageName}

${transactionDetail.hour}`;

    log('transactionDetail: %O', transactionDetail)
    await ctx.reply(ctx.i18n.t('transactions.add.extractedData', {
      receipt: transactionDetail.receipt,
      date: transactionDetail.date,
      hour: transactionDetail.hour,
      amount: transactionDetail.amount,
      currency: transactionDetail.currency,
      card: transactionDetail.card,
      description: transactionDetail.description,
      notes: transactionDetail.notes,
    }), {
      parse_mode: 'Markdown',
    })


    const { userSettings } = ctx.session
    log('ctx.user.settings: %O', userSettings)

    // INICIO REMOVE
    //const text = ctx.message!.text as string
    const text = `${transactionDetail.description} ${transactionDetail.amount}`
    log('ctx.message.text: %O', text)

    const validInput = /^(?<amountOnly>\d{1,}(?:[.,]\d+)?([-+/*^]\d{1,}(?:[.,]\d+)?)*)*$|(?<description>.+)\s(?<amount>\d{1,}(?:[.,]\d+)?([-+/*^]\d{1,}(?:[.,]\d+)?)*)$/
    const match = validInput.exec(text)
    log('match: %O', match)

    if (!match) {
      log('No match... Replying with instruction')
      await ctx.reply(ctx.i18n.t('transactions.add.dontUnderstandImage'), {
        parse_mode: 'Markdown',
      })
      return 
    }

    let amount: string | number | null = match.groups!.amount || match.groups!.amountOnly
    amount = parseAmountInput(amount)
    log('amount: ', amount)

    if (!amount) {
      log('No amount provided... Replying with instruction')
      return ctx.reply(ctx.i18n.t('transactions.add.dontUnderstand'), {
        parse_mode: 'Markdown',
      })
    }

    // FIN REMOVE

    const defaultSourceAccount = await getDefaultSourceAccount(ctx)
    log('defaultSourceAccount: %O', defaultSourceAccount)

    if (!defaultSourceAccount) {
      const kb = new InlineKeyboard().url(
        ctx.i18n.t('labels.OPEN_ASSET_ACCOUNTS_IN_BROWSER'),
        `${userSettings.fireflyUrl}/accounts/asset`
      ).row()

      return ctx.reply(ctx.i18n.t('common.noDefaultSourceAccountExist'), {
        reply_markup: kb
      })
    }

    const defaultDestinationAccount = await getDefaultDestinationAccount(ctx)
    log('defaultDestinationAccount: %O', defaultDestinationAccount)

    // If description is not null, than we'll add transaction in a fast mode
    // without asking a user any additional info
    const description = match.groups!.description
    log('description: ', description)

    // TODO: Add openai model to extract text from image
    if (description) {
      log('Creating quick transaction...')
      const tr = await createQuickTransaction({
        ctx,
        // Telegram message date is a Unix timestamp (10 digits, seconds since the Unix Epoch)
        date: transactionDetail.isoDate ? transactionDetail.isoDate : dayjs().toISOString(),
        amount,
        description,
        sourceAccountId: defaultSourceAccount.id.toString(),
        destinationAccountId: defaultDestinationAccount ? defaultDestinationAccount.id.toString() : ''
      })

      ctx.session.currentTransaction = tr

      return ctx.reply(
        formatTransaction(ctx, tr),
        {
          parse_mode: 'Markdown',
          reply_markup: transactionRecordMenu
        }
      )
    }

    ctx.session.newTransaction = {
      type: undefined, // will be assigned based on the type of operation
      date: (ctx.message?.date ? dayjs.unix(ctx.message.date) : dayjs()).toISOString(),
      description: 'N/A',
      sourceAccount: defaultSourceAccount,
      amount: amount.toString(),
      categoryId: null,
      destAccount: null,
    }

    const page = 1
    const resData = (await firefly(userSettings).Categories.listCategory(undefined, CATEGORIES_PAGE_LIMIT, page)).data
    log('resData.meta: %O', resData.meta)

    ctx.session.categories = resData.data
    ctx.session.pagination = resData.meta.pagination

    return ctx.reply(ctx.i18n.t('transactions.add.selectCategory', { amount: amount }), {
      parse_mode: 'Markdown',
      reply_markup: addTransactionMenu
    })
  } catch (err: any) {
    log('Error: %O', err)
    console.error('Error occurred handling text message: ', err)
    return ctx.reply(err.message)
  }
}

interface ICreateFastTransactionPayload {
  ctx: MyContext
  amount: number
  description: string
  sourceAccountId: string
  destinationAccountId: string
  date: string | undefined
}

async function createQuickTransaction({ ctx, amount, description, sourceAccountId, destinationAccountId, date }: ICreateFastTransactionPayload): Promise<TransactionRead> {
  const log = rootLog.extend('createFastTransaction')
  try {
    const transactionStore = {
      transactions: [{
        type: TransactionTypeProperty.Withdrawal,
        date: dayjs(date || Date.now()).toISOString(),
        amount: amount.toString(),
        description,
        source_id: sourceAccountId,
        destination_id: destinationAccountId,
      }]
    }
    const res = (await firefly(ctx.session.userSettings).Transactions.storeTransaction(transactionStore)).data.data

    log('Created transaction: %O', res)
    log('Created transaction splits: %O', res.attributes.transactions)

    return res
  } catch (err) {
    console.error('Error occurred creating express transaction: ', err)
    return Promise.reject(err)
  }
}

async function getDefaultSourceAccount(ctx: MyContext): Promise<null | AccountAttributes> {
  const log = rootLog.extend('getDefaultSourceAccount')
  try {
    let { defaultSourceAccount } = ctx.session.userSettings

    if (!defaultSourceAccount.name) {
      const firstAccount = (await firefly(ctx.session.userSettings).Accounts.listAccount(
        undefined, ACCOUNTS_PAGE_LIMIT, 1, dayjs().format('YYYY-MM-DD'), AccountTypeFilter.Asset)).data.data[0]
      log('firstAccount: %O', firstAccount)

      // Looks like that a user has not created any Asset accounts yet
      if (!firstAccount) return null

      defaultSourceAccount = {
        id: firstAccount.id,
        name: firstAccount.attributes.name,
        type: firstAccount.attributes.type
      }
    }

    return defaultSourceAccount
  } catch (err) {
    console.error('Error occurred getting default source acount: ', err)
    throw err
  }
}

async function getDefaultDestinationAccount(ctx: MyContext) {
  const log = rootLog.extend('getDefaultDestinationAccount')
  try {
    let { defaultDestinationAccount } = ctx.session.userSettings

    if (!defaultDestinationAccount.name) {
      const cashAccount = (await firefly(ctx.session.userSettings).Accounts.listAccount(
        undefined, ACCOUNTS_PAGE_LIMIT, 1, dayjs().format('YYYY-MM-DD'), AccountTypeFilter.CashAccount)).data.data[0]
      log('cashAccount: %O', cashAccount)

      // For new user accounts there is no default CashAccount created.
      // It is created by Firefly automatically upon creation of first
      // transaction through UI
      if (!cashAccount) {
        log('No cash account found. Returning null...')
        return null
      }

      defaultDestinationAccount = {
        id: cashAccount.id,
        name: cashAccount.attributes.name,
        type: cashAccount.attributes.type
      }
    }

    return defaultDestinationAccount
  } catch (err) {
    console.error('Error occurred getting Cash Account: ', err)
    throw err
  }
}

async function setForeignAmountRouteHandler(ctx: MyContext) {
  const log = rootLog.extend('setForeignAmountRouteHandler')
  log('Entered set foreign amount route handler')
  try {
    log('ctx.session: %O', ctx.session)
    const text = ctx.msg?.text || ''

    log('ctx.message: %O', ctx.message)

    if (!ctx.session.newTransaction) throw new Error('No current transaction in session data!')

    const amount = ctx.session.newTransaction.amount
    const foreignAmount = parseAmountInput(text, amount)
    log('amount: %O', amount)
    log('foreignAmount: %O', foreignAmount)

    ctx.session.newTransaction.foreignAmount = foreignAmount?.toString()

    if (!foreignAmount) {
      log('Bad foreign amount supplied...')
      return ctx.reply(ctx.i18n.t('transactions.edit.badAmountTyped'))
    }

    log('Creating transaction...')
    const tr = await createFireflyTransaction(ctx)
    
    if (ctx.session.deleteBotsMessage?.messageId) {
      log('Deleting original message...')
      await ctx.api.deleteMessage(ctx.session.deleteBotsMessage.chatId!, ctx.session.deleteBotsMessage.messageId)
    }

    // Cleanup session
    cleanupSessionData(ctx)

    ctx.session.currentTransaction = tr

    return ctx.reply(
      formatTransaction(ctx, tr),
      {
        parse_mode: 'Markdown',
        reply_markup: transactionRecordMenu
      }
    )
  } catch (err: any) {
    cleanupSessionData(ctx)
    return handleCallbackQueryError(err, ctx)
  }
}

async function getBufferFromPhoto(log: debug.Debugger, filePath: string): Promise<ArrayBuffer> {

  const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${filePath}`;

  const response = await fetch(fileUrl);
  const buffer: ArrayBuffer = await response.arrayBuffer();
  log('ctx.message.image.buffer.size: %O', buffer.byteLength)

  return buffer;
}

async function getTransactionFromPhoto(log: debug.Debugger, filePath: string): Promise<string> {

  const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${filePath}`;

  const response: ChatCompletion.Choice[] = await openai(config, fileUrl);
  const result = response[0].message.content ?? '';
  log('openai result: %O', result)

  return result;
}

function parseOpenAiResponse(response: string): ReceiptData | null {
  try {
    // Eliminar las comillas invertidas y la etiqueta "json"
    const cleanedText = response.replace(/```json\n?/, "").replace(/```$/, "").trim();

    // Parsear la cadena JSON a un objeto TypeScript
    const parsedData: ReceiptData = JSON.parse(cleanedText);

    return parsedData;
  } catch (error) {
    console.error("❌ Error al parsear la respuesta de OpenAI:", error);
    return null;
  }
}
