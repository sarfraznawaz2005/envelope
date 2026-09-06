<script setup lang="ts">
import Color from '@tiptap/extension-color'
import TiptapImage from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { TextStyle } from '@tiptap/extension-text-style'
import Underline from '@tiptap/extension-underline'
import StarterKit from '@tiptap/starter-kit'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Bold,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Palette,
  Quote,
  RemoveFormatting,
  Underline as UnderlineIcon,
} from '@lucide/vue'
import { ref, watch } from 'vue'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const colorInput = ref<HTMLInputElement | null>(null)

const editor = useEditor({
  content: props.modelValue,
  extensions: [
    StarterKit.configure({ link: false, underline: false }),
    Underline,
    Link.configure({ openOnClick: false, autolink: true }),
    TextStyle,
    Color,
    TiptapImage,
  ],
  editorProps: { attributes: { class: 'prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[220px] px-3 py-2' } },
  onUpdate: ({ editor: e }) => emit('update:modelValue', e.getHTML()),
})

watch(
  () => props.modelValue,
  v => {
    if (editor.value && v !== editor.value.getHTML()) editor.value.commands.setContent(v, { emitUpdate: false })
  },
)

function setLink() {
  const url = window.prompt('Link URL')
  if (url) editor.value?.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
}

function setImage() {
  const url = window.prompt('Image URL')
  if (url) editor.value?.chain().focus().setImage({ src: url }).run()
}

function pickColor() {
  colorInput.value?.click()
}
function applyColor(e: Event) {
  const value = (e.target as HTMLInputElement).value
  if (value) editor.value?.chain().focus().setColor(value).run()
}

function clearFormatting() {
  editor.value?.chain().focus().clearNodes().unsetAllMarks().run()
}

defineExpose({
  insertAtEnd(html: string) {
    const e = editor.value
    if (!e) return
    e.commands.insertContentAt(e.state.doc.content.size, html)
  },
  insertAtStart(html: string) {
    const e = editor.value
    if (!e) return
    e.commands.insertContentAt(0, html)
    e.commands.focus('start')
  },
})
</script>

<template>
  <div class="border rounded-md flex flex-col min-h-0">
    <div class="flex items-center gap-0.5 border-b p-1 shrink-0">
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" class="p-1.5 rounded hover:bg-muted" :class="editor?.isActive('bold') ? 'bg-muted' : ''" @click="editor?.chain().focus().toggleBold().run()"><Bold class="size-3.5" /></button>
        </TooltipTrigger>
        <TooltipContent>Bold</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" class="p-1.5 rounded hover:bg-muted" :class="editor?.isActive('italic') ? 'bg-muted' : ''" @click="editor?.chain().focus().toggleItalic().run()"><Italic class="size-3.5" /></button>
        </TooltipTrigger>
        <TooltipContent>Italic</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" class="p-1.5 rounded hover:bg-muted" :class="editor?.isActive('underline') ? 'bg-muted' : ''" @click="editor?.chain().focus().toggleUnderline().run()"><UnderlineIcon class="size-3.5" /></button>
        </TooltipTrigger>
        <TooltipContent>Underline</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" class="p-1.5 rounded hover:bg-muted" @click="pickColor"><Palette class="size-3.5" /></button>
        </TooltipTrigger>
        <TooltipContent>Text color</TooltipContent>
      </Tooltip>
      <input ref="colorInput" type="color" class="hidden" @input="applyColor">
      <span class="w-px h-4 bg-border mx-1" />
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" class="p-1.5 rounded hover:bg-muted" :class="editor?.isActive('bulletList') ? 'bg-muted' : ''" @click="editor?.chain().focus().toggleBulletList().run()"><List class="size-3.5" /></button>
        </TooltipTrigger>
        <TooltipContent>Bulleted list</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" class="p-1.5 rounded hover:bg-muted" :class="editor?.isActive('orderedList') ? 'bg-muted' : ''" @click="editor?.chain().focus().toggleOrderedList().run()"><ListOrdered class="size-3.5" /></button>
        </TooltipTrigger>
        <TooltipContent>Numbered list</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" class="p-1.5 rounded hover:bg-muted" :class="editor?.isActive('blockquote') ? 'bg-muted' : ''" @click="editor?.chain().focus().toggleBlockquote().run()"><Quote class="size-3.5" /></button>
        </TooltipTrigger>
        <TooltipContent>Quote</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" class="p-1.5 rounded hover:bg-muted" :class="editor?.isActive('link') ? 'bg-muted' : ''" @click="setLink"><LinkIcon class="size-3.5" /></button>
        </TooltipTrigger>
        <TooltipContent>Link</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" class="p-1.5 rounded hover:bg-muted" @click="setImage"><ImageIcon class="size-3.5" /></button>
        </TooltipTrigger>
        <TooltipContent>Image</TooltipContent>
      </Tooltip>
      <span class="w-px h-4 bg-border mx-1" />
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" class="p-1.5 rounded hover:bg-muted" @click="clearFormatting"><RemoveFormatting class="size-3.5" /></button>
        </TooltipTrigger>
        <TooltipContent>Clear formatting</TooltipContent>
      </Tooltip>
    </div>
    <EditorContent :editor="editor" class="flex-1 overflow-y-auto" />
  </div>
</template>
