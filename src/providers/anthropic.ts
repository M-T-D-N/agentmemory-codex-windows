import type Anthropic from '@anthropic-ai/sdk'
import type { MemoryProvider } from '../types.js'

export class AnthropicProvider implements MemoryProvider {
  name = 'anthropic'
  private clientPromise: Promise<Anthropic> | null = null
  private clientOptions: { apiKey: string; baseURL?: string }
  private model: string
  private maxTokens: number

  constructor(apiKey: string, model: string, maxTokens: number, baseURL?: string) {
    this.clientOptions = { apiKey, ...(baseURL ? { baseURL } : {}) }
    this.model = model
    this.maxTokens = maxTokens
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt)
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt)
  }

  async describeImage(imageData: string, mimeType: string, prompt: string): Promise<string> {
    const client = await this.loadClient()
    const response = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: imageData },
          },
          { type: 'text', text: prompt },
        ],
      }],
    })

    const textBlock = response.content.find((b) => b.type === 'text')
    return textBlock?.text ?? ''
  }

  private async call(systemPrompt: string, userPrompt: string): Promise<string> {
    const client = await this.loadClient()
    const response = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })

    const textBlock = response.content.find((b) => b.type === 'text')
    return textBlock?.text ?? ''
  }

  private loadClient(): Promise<Anthropic> {
    if (!this.clientPromise) {
      this.clientPromise = import('@anthropic-ai/sdk').then(({ default: Client }) => new Client(this.clientOptions))
    }
    return this.clientPromise
  }
}
