import type { SerializedEditorState } from 'lexical'
import type { BasePayload, PayloadRequest } from 'payload'

import Handlebars from 'handlebars'
import asyncHelpers from 'handlebars-async-helpers'

import { ActionMenuItems, Endpoints } from '../types.js'

import { GenerationModels } from '../ai/models/index.js'
import { defaultPrompts } from '../ai/prompts.js'
import {
  PLUGIN_API_ENDPOINT_GENERATE,
  PLUGIN_API_ENDPOINT_GENERATE_UPLOAD,
  PLUGIN_INSTRUCTIONS_TABLE,
  PLUGIN_NAME,
} from '../defaults.js'
import { getFieldBySchemaPath } from '../utilities/getFieldBySchemaPath.js'
import { lexicalToHTML } from '../utilities/lexicalToHTML.js'
import { lexicalSchema } from '../ai/editor/lexical.schema.js'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'

const asyncHandlebars = asyncHelpers(Handlebars)

const replacePlaceholders = (prompt: string, values: object) => {
  return asyncHandlebars.compile(prompt, { trackIds: true })(values)
}

const assignPrompt = async (
  action: ActionMenuItems,
  {
    type,
    actionParams,
    context,
    field,
    systemPrompt = '',
    template,
    layout,
  }: {
    actionParams: Record<any, any>
    context: object
    field: string
    systemPrompt: string
    template: string
    type: string
    layout: string
  },
) => {
  const prompt = await replacePlaceholders(template, context)

  const toLexicalHTML = type === 'richText' ? 'toLexicalHTML' : ''

  const assignedPrompts = {
    prompt,
    system: systemPrompt,
    layout,
  }

  if (action === 'Compose') {
    return assignedPrompts
  }

  const { system: getSystemPrompt, layout: getLayout } = defaultPrompts.find(
    (p) => p.name === action,
  )

  let updatedLayout = layout
  if (getLayout) {
    updatedLayout = getLayout()
  }

  const system = getSystemPrompt({
    ...(actionParams || {}),
    prompt,
    systemPrompt,
  })

  return {
    prompt: await replacePlaceholders(`{{${toLexicalHTML} ${field}}}`, context),
    system,
    layout: updatedLayout,
  }
}

const registerEditorHelper = (payload, schemaPath) => {
  //TODO: add autocomplete ability using handlebars template on PromptEditorField and include custom helpers in dropdown

  let fieldInfo = getFieldInfo(payload.collections, schemaPath)
  const schemaPathChunks = schemaPath.split('.')

  asyncHandlebars.registerHelper(
    'toLexicalHTML',
    async function (content: SerializedEditorState, options) {
      const collectionSlug = schemaPathChunks[0]
      const { ids } = options
      for (const id of ids) {
        //TODO: Find a better way to get schemaPath of defined field in prompt editor
        const path = `${collectionSlug}.${id}`
        fieldInfo = getFieldInfo(payload.collections, path)
      }

      const html = await lexicalToHTML(content, fieldInfo.editor?.editorConfig)
      return new asyncHandlebars.SafeString(html)
    },
  )
}

const getFieldInfo = (collections: BasePayload['collections'], schemaPath: string) => {
  let fieldInfo = null
  //TODO: Only run below for enabled collections
  for (const collectionsKey in collections) {
    const collection = collections[collectionsKey]
    fieldInfo = getFieldBySchemaPath(collection.config, schemaPath)
    if (fieldInfo) {
      return fieldInfo
    }
  }
}

export const endpoints: Endpoints = {
  textarea: {
    handler: async (req: PayloadRequest) => {
      const data = await req.json?.()

      const { locale = 'en', options } = data
      const { action, actionParams, instructionId } = options
      const contextData = data.doc

      if (!instructionId) {
        throw new Error(
          `Instruction ID is required for "${PLUGIN_NAME}" to work, please check your configuration`,
        )
      }

      let instructions = await req.payload.findByID({
        id: instructionId,
        collection: PLUGIN_INSTRUCTIONS_TABLE,
      })

      const { collections } = req.payload.config
      const collection = collections.find(
        (collection) => collection.slug === PLUGIN_INSTRUCTIONS_TABLE,
      )

      const { editorConfig: { schema: editorSchema = lexicalSchema() } = {} } =
        collection.custom || {}

      const { prompt: promptTemplate = '' } = instructions

      const schemaPath = instructions['schema-path'] as string
      const fieldName = schemaPath?.split('.').pop()

      registerEditorHelper(req.payload, schemaPath)

      const { defaultLocale, locales = [] } = req.payload.config.localization || {}
      const localeData = locales.find((l) => {
        return l.code === locale
      })

      const localeInfo = localeData?.label[defaultLocale] || locale

      //TODO: remove this
      const opt = {
        locale: localeInfo,
        modelId: instructions['model-id'],
      }

      const model = GenerationModels.find((model) => model.id === opt.modelId)
      const settingsName = model.settings?.name
      const modelOptions = instructions[settingsName] as {
        system: string
        layout: string
      }

      const prompts = await assignPrompt(action, {
        type: instructions['field-type'] as string,
        actionParams,
        context: contextData,
        field: fieldName,
        systemPrompt: modelOptions.system,
        template: promptTemplate as string,
        layout: modelOptions.layout,
      })

      console.log('Running handler with prompts:', prompts)
      return model
        .handler?.(prompts.prompt, {
          ...modelOptions,
          ...opt,
          system: prompts.system,
          editorSchema,
          layout: prompts.layout,
        })
        .catch((error) => {
          console.error('Error: endpoint - generating text:', error)
          return new Response(JSON.stringify(error.message), { status: 500 })
        })
    },
    method: 'post',
    path: PLUGIN_API_ENDPOINT_GENERATE,
  },
  upload: {
    handler: async (req: PayloadRequest) => {
      const data = await req.json?.()

      const { options } = data
      const { instructionId, uploadCollectionSlug } = options
      const contextData = data.doc

      let instructions = { 'model-id': '', prompt: '' }

      if (instructionId) {
        // @ts-expect-error
        instructions = await req.payload.findByID({
          id: instructionId,
          collection: PLUGIN_INSTRUCTIONS_TABLE,
        })
      }

      const { prompt: promptTemplate = '' } = instructions
      const schemaPath = instructions['schema-path']

      registerEditorHelper(req.payload, schemaPath)

      const text = await replacePlaceholders(promptTemplate, contextData)
      const modelId = instructions['model-id']
      console.log('prompt text:', text)

      const model = GenerationModels.find((model) => model.id === modelId)
      const settingsName = model.settings?.name
      const modelOptions = instructions[settingsName] || {}
      console.log('modelOptions', modelOptions)

      const result = await model.handler?.(text, modelOptions)

      const assetData = await req.payload.create({
        collection: uploadCollectionSlug,
        data: result.data,
        file: result.file,
      })

      console.log('assetData', assetData)

      return new Response(
        JSON.stringify({
          result: {
            id: assetData.id,
            alt: assetData.alt,
          },
        }),
      )
    },
    method: 'post',
    path: PLUGIN_API_ENDPOINT_GENERATE_UPLOAD,
  },
}
