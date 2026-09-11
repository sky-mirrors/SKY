<template>
  <div class="review-form" v-if="showForm">
    <h4 class="section-title">Rule Review</h4>
    <div class="form-group">
      <label class="form-label">Reviewer Name</label>
      <input
        class="form-input"
        v-model="reviewerName"
        placeholder="Enter your name"
      />
    </div>
    <div class="form-group">
      <label class="form-label">Verdict</label>
      <select class="form-select" v-model="verdict">
        <option value="approved">Approved</option>
        <option value="needs_revision">Needs Revision</option>
        <option value="rejected">Rejected</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Comment</label>
      <textarea
        class="form-textarea"
        v-model="comment"
        placeholder="Add review comments..."
        rows="3"
      ></textarea>
    </div>
    <button class="submit-btn" @click="onSubmit" :disabled="!reviewerName.trim()">
      Submit Review
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRuleStore } from '@/domains/app'

const props = defineProps<{
  ruleId: string
  ruleStatus: string
}>()

const ruleStore = useRuleStore()

const reviewerName = ref('')
const verdict = ref<'approved' | 'needs_revision' | 'rejected'>('approved')
const comment = ref('')

const showForm = computed(() => props.ruleStatus === 'testing')

function onSubmit() {
  if (!reviewerName.value.trim()) return
  if (verdict.value === 'approved') {
    ruleStore.approveRule(props.ruleId, reviewerName.value.trim())
  } else if (verdict.value === 'needs_revision') {
    ruleStore.changeRuleStatus(props.ruleId, 'draft')
  } else {
    ruleStore.changeRuleStatus(props.ruleId, 'deprecated')
  }
  reviewerName.value = ''
  comment.value = ''
  verdict.value = 'approved'
}
</script>

<style scoped>
.review-form {
  background: rgba(26, 26, 62, 0.5);
  border: 1px solid #2a2a5e;
  border-radius: 6px;
  padding: 10px 12px;
}
.section-title {
  font-size: 12px;
  color: #e0e0ff;
  font-weight: 600;
  margin: 0 0 8px;
}
.form-group {
  margin-bottom: 8px;
}
.form-label {
  display: block;
  font-size: 10px;
  color: #8888bb;
  margin-bottom: 3px;
}
.form-input,
.form-select,
.form-textarea {
  width: 100%;
  background: #0d0d2b;
  border: 1px solid #2a2a5e;
  border-radius: 4px;
  padding: 6px 8px;
  color: #e0e0ff;
  font-size: 11px;
  outline: none;
}
.form-input:focus,
.form-select:focus,
.form-textarea:focus {
  border-color: #00ccff;
}
.form-select {
  cursor: pointer;
}
.form-select option {
  background: #0d0d2b;
  color: #e0e0ff;
}
.form-textarea {
  resize: vertical;
  line-height: 1.5;
  font-family: inherit;
}
.submit-btn {
  padding: 6px 16px;
  background: rgba(0, 204, 255, 0.12);
  border: 1px solid rgba(0, 204, 255, 0.3);
  border-radius: 4px;
  color: #00ccff;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}
.submit-btn:hover:not(:disabled) {
  background: rgba(0, 204, 255, 0.22);
}
.submit-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
